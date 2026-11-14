import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTianaClient, createTianaFetch} from '../dist/index.js';

const credential = (accessToken = 'at1', sessionId = 's1') => ({accessToken, sessionId, expiresAt: Date.now() + 600_000});
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; };
const denied = () => Response.json({error:{code:'AUTHENTICATION_REQUIRED'}},{status:401});
const grant = (extra = {}) => ({instance_id:'i',branch_id:null,endpoint_id:'ep-7k3rbz6104qg3qk2z6de5z2vmh',origin:'https://ep-7k3rbz6104qg3qk2z6de5z2vmh.db.service.internal.tiana.com',engine:'sqlite',token:'dt1',expires_at:Math.floor(Date.now()/1000)+1800,...extra});
const make = getCredential => createTianaClient({managementOrigin:'https://console.test',getCredential});

test('session reports disconnected initially and when the customer session ends', async t => {
  let now = Date.now(), signedIn = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).endsWith('/connections') ? grant() : {principal_id:'u',tenant_id:'t',email:'u@example.test'}));
  const client = make(async () => signedIn ? credential() : null);
  assert.deepEqual(await client.session(), {connected:false,session:null});
  signedIn = true;
  assert.equal((await client.session()).connected, true);
  const connection = await client.connections.get({instanceId:'i'});
  signedIn = false; now += 600_000;
  assert.deepEqual(await client.session(), {connected:false,session:null});
  await assert.rejects(connection.auth.getAccessToken(), {code:'AUTH_LOGIN_REQUIRED'});
});

test('customer callback is arbitrary; management preserves revision, query, response and stable retry body', async t => {
  let credentials = 0;
  const calls = [];
  t.mock.method(globalThis,'fetch',async (url,init) => {
    calls.push({url,init});
    if (calls.length===1) return denied();
    return Response.json({operation_id:'op'}, {status:202, headers:{ETag:'rev'}});
  });
  const client = make(async () => credential(`at${++credentials}`));
  const result = await client.instances.create({display_name:'demo',engine:'sqlite'});
  assert.equal(result.response.status,202);
  assert.equal(result.response.headers.get('etag'),'rev');
  assert.equal(calls.length,2);
  assert.equal(calls[0].init.body,calls[1].init.body);
  assert.equal(calls[0].init.headers.get('X-Request-ID'),calls[1].init.headers.get('X-Request-ID'));
  assert.equal(JSON.parse(calls[0].init.body).request_id,calls[0].init.headers.get('X-Request-ID'));
  assert.equal(calls[1].init.credentials,'omit');
  await client.instances.update('i/a','r1',{notes:'n'});
  assert.equal(calls[2].url,'https://console.test/api/v1/instances/i%2Fa');
  assert.equal(calls[2].init.headers.get('If-Match'),'r1');
  await client.instances.list({search:'a&b'});
  assert.equal(calls[3].url,'https://console.test/api/v1/instances?page=1&page_size=20&search=a%26b');
});

test('concurrent and late 401s share one credential replacement', async t => {
  let n=0;
  const gate=deferred();
  t.mock.method(globalThis,'fetch',async (_url,init) => {
    if(init.headers.get('Authorization')==='Bearer at1') { await gate.promise; return denied(); }
    return Response.json({items:[]});
  });
  const client=make(async()=>credential(`at${++n}`));
  const work=Array.from({length:8},()=>client.instances.list());
  await new Promise(r=>setImmediate(r)); gate.resolve(); await Promise.all(work);
  assert.equal(n,2);
});

test('no replay after account switch, unchanged AT, 5xx or network failure',async t=>{
  for(const mode of ['account','same','500','network']) {
    let n=0,calls=0;
    const network=new Error('network');
    const mock=t.mock.method(globalThis,'fetch',async()=>{ calls++; if(mode==='network') throw network; return mode==='500'?Response.json({error:{code:'failure'}},{status:500}):denied(); });
    const client=make(async()=>{n++;return credential('at1',mode==='account'&&n>1?'s2':'s1');});
    await assert.rejects(client.instances.list(), e=>mode==='network'?e===network:e.status===(mode==='500'?500:401));
    assert.equal(calls,1);mock.mock.restore();
  }
});

test('clearSession discards late credentials; rejected callback can be called again',async t=>{
  const gate=deferred();let n=0;
  t.mock.method(globalThis,'fetch',async()=>Response.json({items:[]}));
  const client=make(async()=>{n++;return n===1?gate.promise:credential();});
  const old=client.instances.list();await Promise.resolve();client.clearSession();gate.resolve(credential());
  await assert.rejects(old,{code:'AUTH_LOGIN_REQUIRED'});
  await client.instances.list();assert.equal(n,2);
  const failure=new Error('customer offline');let attempts=0;
  const retry=make(async()=>{if(++attempts===1)throw failure;return credential();});
  await assert.rejects(retry.instances.list(),e=>e===failure);await retry.instances.list();
});

test('cancelling one credential waiter does not cancel others',async t=>{
  const gate=deferred();let n=0;
  t.mock.method(globalThis,'fetch',async()=>Response.json({items:[]}));
  const client=make(async()=>{n++;return gate.promise;});const abort=new AbortController();
  const first=client.instances.list({}, {signal:abort.signal}); const second=client.instances.list();
  abort.abort();await assert.rejects(first,{name:'AbortError'});gate.resolve(credential());await second;assert.equal(n,1);
});

test('DT cache renews on demand, shares requests and invalidates previous providers',async t=>{
  let now=Date.now(),n=0;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>{n++;return Response.json(grant({token:`dt${n}`}));});
  const client=make(async()=>credential());
  const [a,b]=await Promise.all([client.connections.get({instanceId:'i'}),client.connections.get({instanceId:'i'})]);
  assert.equal(n,1);assert.equal(await a.auth.getAccessToken(),'dt1');
  now+=1771_000;
  assert.deepEqual(await Promise.all([a.auth.getAccessToken(),b.auth.getAccessToken()]),['dt2','dt2']);assert.equal(n,2);
  client.clearSession();await assert.rejects(a.auth.getAccessToken(),{code:'AUTH_LOGIN_REQUIRED'});
  assert.equal(n,2);
});

test('changed endpoint rejects before sending a data body',async t=>{
  let now=Date.now(),calls=0;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async url=>{ assert.ok(String(url).includes('/integrations/connections'));return Response.json(grant(++calls===1?{}:{endpoint_id:'changed'})); });
  const client=make(async()=>credential());const c=await client.connections.get({instanceId:'i'});
  const dataFetch=createTianaFetch({origin:c.origin,auth:c.auth});now+=1771_000;
  await assert.rejects(dataFetch(`${c.origin}/`,{method:'POST',body:'SELECT 1'}),{code:'CONNECTION_CHANGED'});
  assert.equal(calls,2);
});

test('old provider cannot renew under a new customer session',async t=>{
  let now=Date.now(),session='s1',calls=0;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json(grant());});
  const client=make(async()=>credential('at',session));const c=await client.connections.get({instanceId:'i'});
  now+=1800_000;session='s2';await assert.rejects(c.auth.getAccessToken(),{code:'AUTH_LOGIN_REQUIRED'});assert.equal(calls,1);
});


test('clearSession stops requests waiting on an already cached credential', async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({items:[]});});
 const client=make(async()=>credential());await client.instances.list();
 const old=client.instances.list();client.clearSession();
 await assert.rejects(old,{code:'AUTH_LOGIN_REQUIRED'});assert.equal(calls,1);
});
