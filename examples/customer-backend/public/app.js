import {createTianaClient,createTianaFetch} from '/sdk/index.js';
import {managementOrigin} from '/config.js';
const $=id=>document.getElementById(id);
const notices={cancelled:'已取消授权，原连接保持不变。',login_required:'请重新连接 Tiana。',connection_failed:'连接未完成，请重新发起。',logout_unconfirmed:'旧连接的远端退出结果未确认，可在 Console 设备管理中下线。'};
async function customer(path,body={}) {
  const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
  const value=await response.json();if(!response.ok) throw new Error(value.error?.code ?? `HTTP ${response.status}`);return value;
}
const tiana=createTianaClient({managementOrigin,getCredential:async()=>{
  const value=await customer('/tiana/token');if(value.notice) $('notice').textContent=notices[value.notice.code]??value.notice.code;
  return value.connected?{sessionId:value.session.session_id,accessToken:value.session.access_token,expiresAt:value.session.expires_at}:null;
}});
let selected,revision,connection;
function output(value) {$('result').textContent=typeof value==='string'?value:JSON.stringify(value,null,2);}
async function run(action) {$('error').textContent='';try{return await action();}catch(error){$('error').textContent=error.message;return undefined;}}
$('location').textContent=location.pathname+location.search+location.hash;
$('connect').onclick=()=>run(async()=>{const value=await customer('/tiana/start',{return_to:location.pathname+location.search+location.hash});location.assign(value.authorize_url);});
$('logout').onclick=()=>run(async()=>{try{const value=await customer('/tiana/logout');$('notice').textContent=value.notice?notices[value.notice.code]:'已退出 Tiana 连接。';}finally{tiana.clearSession();selected=null;connection=null;$('connected').hidden=true;$('logout').hidden=true;$('connect').textContent='连接 Tiana';}});
async function list() {
  const current=await tiana.session();$('connected').hidden=!current.connected;$('logout').hidden=!current.connected;
  if(!current.connected)return;
  $('connect').textContent='重新连接';$('identity').textContent=`账号 ${current.session.email||current.session.user_id} · 空间 ${current.session.tenant_id}`;
  const {data}=await tiana.instances.list();$('instances').replaceChildren();
  for(const instance of data.items){const row=document.createElement('article');row.className='instance';const text=document.createElement('div'),name=document.createElement('b'),description=document.createElement('small'),button=document.createElement('button');name.textContent=instance.display_name;description.textContent=`${instance.engine} · ${instance.product_state} · ${instance.id}`;text.append(name,description);button.textContent='打开';button.className='secondary';button.onclick=()=>run(()=>open(instance.id));row.append(text,button);$('instances').append(row);}
  if(!data.items.length)$('instances').textContent='还没有实例，可以在上方创建。';
}
async function open(id) {const result=await tiana.instances.get(id);selected=result.data;revision=result.response.headers.get('ETag');connection=null;$('detail').hidden=false;$('detail-title').textContent=selected.display_name;$('enabled').textContent=selected.enabled?'停用':'启用';output(result.data);}
async function accepted(result) {
  output(result.data);
  const {instance_id,operation_id}=result.data;
  if(!operation_id)return;
  const until=Date.now()+60_000;
  while(Date.now()<until){await new Promise(resolve=>setTimeout(resolve,1000));const receipt=await tiana.operations.get(instance_id,operation_id);output(receipt.data);if(['success','failed'].includes(receipt.data.state))break;}
  await list();
}
$('reload').onclick=()=>run(list);
$('create').onsubmit=event=>{event.preventDefault();void run(async()=>{const button=event.target.querySelector('button');button.disabled=true;try{await accepted(await tiana.instances.create({display_name:$('name').value,engine:$('engine').value}));}finally{button.disabled=false;}});};
$('rename').onclick=()=>run(async()=>{const name=prompt('实例名称',selected.display_name);if(name===null)return;await tiana.instances.update(selected.id,revision,{display_name:name});await open(selected.id);await list();});
$('enabled').onclick=()=>run(async()=>{await accepted(await tiana.instances.setEnabled(selected.id,!selected.enabled));await open(selected.id);});
$('delete').onclick=()=>run(async()=>{if(!confirm(`删除 ${selected.display_name}？`))return;await accepted(await tiana.instances.delete(selected.id,{}));$('detail').hidden=true;selected=null;connection=null;});
$('branches').onclick=()=>run(async()=>output((await tiana.branches.list(selected.id)).data));
async function connect(){connection=await tiana.connections.get({instanceId:selected.id});return connection;}
$('connection').onclick=()=>run(async()=>{const value=await connect();output({instanceId:value.instanceId,endpointId:value.endpointId,origin:value.origin,engine:value.engine,authorization:'临时 DT 已取得，由 SDK 管理续期'});});
$('execute').onclick=()=>run(async()=>{const c=connection??await connect();const sqlFetch=createTianaFetch({origin:c.origin,auth:c.auth,requestBodyMode:'buffered'});const response=await sqlFetch(`${c.origin}/v3/pipeline`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql:$('sql').value,args:[],want_rows:true}},{type:'close'}]})});output(await response.json());});
$('function').onclick=()=>run(async()=>{const c=connection??await connect();const fn=createTianaFetch({origin:c.origin,auth:c.auth,protocol:'tiana-http',requestBodyMode:'buffered'});const response=await fn(new URL($('function-path').value,c.origin));output({status:response.status,body:await response.text()});});
await run(async()=>{await list();if(!$('connected').hidden){const {data}=await tiana.appTypes.list();for(const item of data.items){const option=document.createElement('option');option.value=item.engine;option.textContent=item.display_name;$('engine').append(option);}}});
