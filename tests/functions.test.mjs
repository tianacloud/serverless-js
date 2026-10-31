import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTianaFunctions } from '../dist/index.js';
const origin = 'https://fn.example.test';
const grant = (id, extra = {}) => ({ instance_id:id, origin, token:'fixture-token', expires_at:Math.floor(Date.now()/1000)+60, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r});return {promise,resolve}; };

test('shares issuance per target and caches valid grants; business HTTP retains semantics',async () => {
 const gate=deferred(),issued=[],sent=[];
 const functions=createTianaFunctions({connection:async id=>{issued.push(id);await gate.promise;return grant(id)},fetch:async (url,init)=>{sent.push([url.href,init]);return new Response('created',{status:201})}});
 const a=functions.fetch('a','/orders?x=1',{method:'POST',body:'data'}),b=functions.fetch('a','/items'),c=functions.fetch('b','/items');
 await new Promise(setImmediate);assert.deepEqual(issued,['a','b']);gate.resolve();
 for(const res of await Promise.all([a,b,c])){assert.equal(res.status,201);assert.equal(await res.text(),'created')}
 await functions.fetch('a','/cached');assert.equal(issued.length,2);assert.equal(sent.length,4);
 assert.equal(sent[0][0],origin+'/orders?x=1');assert.equal(sent[0][1].body,'data');
 for(const [,req]of sent){assert.equal(req.credentials,'omit');assert.equal(req.redirect,'error');assert.equal(req.headers.get('authorization'),'Bearer fixture-token')}
 functions.dispose();
});

test('one cancelled waiter does not cancel shared issuance or another request',async()=>{
 const gate=deferred();let issued=0,sent=0,grantSignal;
 const fn=createTianaFunctions({connection:async(id,{signal})=>{issued++;grantSignal=signal;await gate.promise;return grant(id)},fetch:async()=>{sent++;return new Response('ok')}});
 const abort=new AbortController();const a=fn.fetch('a','/',{signal:abort.signal});const rejected=assert.rejects(a,{name:'AbortError'});
 const b=fn.fetch('a','/');await new Promise(setImmediate);abort.abort();await rejected;assert.equal(grantSignal.aborted,false);gate.resolve();await b;assert.equal(issued,1);assert.equal(sent,1);fn.dispose();
});

test('failed grants and business errors are not automatically replayed',async()=>{
 let issued=0,sent=0,fail=true;
 const fn=createTianaFunctions({connection:async id=>{issued++;if(fail)throw new Error('denied');return grant(id)},fetch:async()=>{sent++;return new Response('unauthorized',{status:401})}});
 await assert.rejects(fn.fetch('a','/'));assert.equal(sent,0);assert.equal(issued,1);
 fail=false;const response=await fn.fetch('a','/');assert.equal(response.status,401);assert.equal(sent,1);assert.equal(issued,2);
 await fn.fetch('a','/');assert.equal(sent,2);assert.equal(issued,3);fn.dispose();
});

test('disposal cancels data, discards late grants and isolates next login context',async()=>{
 const gate=deferred();let sent=0,signal;
 const old=createTianaFunctions({connection:async(id,opts)=>{signal=opts.signal;await gate.promise;return grant(id)},fetch:async()=>{sent++;return new Response('old')}});
 const pending=old.fetch('a','/');const failure=assert.rejects(pending,{name:'AbortError'});await new Promise(setImmediate);old.dispose();await failure;assert.equal(signal.aborted,true);gate.resolve();
 const fresh=createTianaFunctions({connection:async id=>grant(id,{token:'next-user'}),fetch:async(_,init)=>{assert.equal(init.headers.get('authorization'),'Bearer next-user');return new Response('new')}});
 await fresh.fetch('a','/');await new Promise(setImmediate);assert.equal(sent,0);await assert.rejects(old.fetch('a','/'),{name:'AbortError'});fresh.dispose();
 const began=deferred();let bodySignal;
 const stream=createTianaFunctions({connection:async id=>grant(id),fetch:async(_,init)=>{bodySignal=init.signal;began.resolve();return new Response('stream')}});
 await stream.fetch('a','/');await began.promise;stream.dispose();assert.equal(bodySignal.aborted,true);
});

test('grants cannot authorize a different target or origin and redirects cannot carry credentials',async()=>{
 for(const bad of [{instance_id:'other'}, {origin:'http://private.test'}, {origin:origin+'/path'}, {expires_at:0}]){
  let sent=0;const fn=createTianaFunctions({connection:async id=>grant(id,bad),fetch:async()=>{sent++;return new Response()}});
  await assert.rejects(fn.fetch('a','/'));assert.equal(sent,0);fn.dispose();
 }
 let sent=0;const fn=createTianaFunctions({connection:async id=>grant(id),fetch:async()=>{sent++;return new Response()}});
 for(const path of ['https://other.test/x','//other.test/x','https://name@fn.example.test/']) await assert.rejects(fn.fetch('a',path),TypeError);
 assert.equal(sent,0);fn.dispose();
});

test('expiry reissues on demand and a delayed old denial does not evict the newer grant',async()=>{
 const original=Date.now;let now=original(),issued=0;const first=deferred();
 Date.now=()=>now;
 try{
  const fn=createTianaFunctions({connection:async id=>grant(id,{token:'token-'+(++issued)}),fetch:async(_,init)=>init.headers.get('authorization')==='Bearer token-1'?first.promise:new Response('new')});
  const old=fn.fetch('a','/');await new Promise(setImmediate);now+=61000;
  await fn.fetch('a','/');assert.equal(issued,2);first.resolve(new Response('expired',{status:401}));await old;
  await fn.fetch('a','/');assert.equal(issued,2);fn.dispose();
 }finally{Date.now=original}
});

test('cancelled calls do not issue and network failures do not replay data',async()=>{
 let issued=0,sent=0;const abort=new AbortController();abort.abort();
 const fn=createTianaFunctions({connection:async id=>{issued++;return grant(id)},fetch:async()=>{sent++;throw new TypeError('network')}});
 await assert.rejects(fn.fetch('a','/',{signal:abort.signal}));assert.equal(issued,0);
 await assert.rejects(fn.fetch('a','/',{method:'POST',body:'write'}));assert.equal(sent,1);assert.equal(issued,1);fn.dispose();
});
