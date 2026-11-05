import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTianaFunctions } from '../dist/index.js';
const tick = () => new Promise(setImmediate);
const grant = id => ({ instance_id:id, origin:'https://fn.example.test', token:'secret+/=&', expires_at:Math.floor(Date.now()/1000)+60 });
class Socket extends EventTarget {
 static all=[];
 readyState=0; closes=0; listeners=new Map();
 constructor(url, protocols) { super(); this.url=String(url); this.protocols=protocols; Socket.all.push(this); }
 addEventListener(type, fn, options) { super.addEventListener(type,fn,options); this.listeners.set(type,(this.listeners.get(type)||0)+1); }
 removeEventListener(type, fn, options) { super.removeEventListener(type,fn,options); this.listeners.set(type,(this.listeners.get(type)||0)-1); }
 emit(type) { if(type==='open')this.readyState=1;if(type==='close')this.readyState=3;this.dispatchEvent(new Event(type)); }
 close() { this.closes++;this.readyState=2; }
}
const connect = async (fn,path='/stream',options) => { const result=fn.websocket('a',path,options); await tick(); return { result, socket:Socket.all.at(-1) }; };
test('native sockets share credentials with fetch and preserve business query and protocols',async()=>{
 const old=globalThis.WebSocket; globalThis.WebSocket=Socket;Socket.all=[];
 try {
 let issued=0;const fn=createTianaFunctions({connection:async id=>{issued++;return grant(id)},fetch:async()=>new Response('',{status:403})});
 const {result,socket}=await connect(fn,'/stream?a=1&access_token=old',{protocols:['chat','binary']});
 const url=new URL(socket.url);assert.equal(url.protocol,'wss:');assert.equal(url.pathname,'/stream');assert.equal(url.searchParams.get('a'),'1');assert.equal(url.searchParams.get('access_token'),'secret+/=&');assert.deepEqual(socket.protocols,['chat','binary']);
 socket.emit('open');assert.equal(await result,socket);
 let messages=0;socket.addEventListener('message',()=>messages++);socket.emit('message');assert.equal(messages,1);
 const b=await connect(fn);b.socket.emit('open');await b.result;assert.equal(issued,1);
 socket.emit('close');fn.dispose();assert.equal(socket.closes,0);assert.equal(b.socket.closes,1);
 await assert.rejects(fn.websocket('a','/'),{name:'AbortError'});
 const other=createTianaFunctions({connection:async id=>{issued++;return grant(id)},fetch:async()=>new Response('',{status:403})});
 await other.fetch('a','/');const c=await connect(other);c.socket.emit('open');await c.result;assert.equal(issued,3);other.dispose();
 } finally {globalThis.WebSocket=old;}
});
test('handshake failures retain cache, clean listeners and close their socket',async()=>{
 const old=globalThis.WebSocket;globalThis.WebSocket=Socket;
 try {let issued=0;const fn=createTianaFunctions({connection:async id=>{issued++;return grant(id)}});
 for(const event of ['error','close']){const {result,socket}=await connect(fn);const rejected=assert.rejects(result,/Function WebSocket/);socket.emit(event);await rejected;assert.equal(socket.closes,1);assert.equal([...socket.listeners.values()].reduce((a,b)=>a+b,0),0);}
 assert.equal(issued,1);fn.dispose();
 }finally{globalThis.WebSocket=old;}
});
test('cancellation isolates credential waiters and stops owning socket after open',async()=>{
 const old=globalThis.WebSocket;globalThis.WebSocket=Socket;Socket.all=[];
 try {let release,providerSignal;const gate=new Promise(r=>release=r);const fn=createTianaFunctions({connection:async(id,{signal})=>{providerSignal=signal;await gate;return grant(id)}});
 const abort=new AbortController();const a=fn.websocket('a','/',{signal:abort.signal});const fail=assert.rejects(a,{name:'AbortError'});const b=fn.websocket('a','/');await tick();abort.abort();await fail;assert.equal(providerSignal.aborted,false);release();await tick();assert.equal(Socket.all.length,1);Socket.all[0].emit('open');await b;
 const cancel=new AbortController();const c=await connect(fn,'/',{signal:cancel.signal});c.socket.emit('open');await c.result;cancel.abort();assert.equal(c.socket.closes,0);
 const during=new AbortController();const d=await connect(fn,'/',{signal:during.signal});const rejected=assert.rejects(d.result,{name:'AbortError'});during.abort();await rejected;assert.equal(d.socket.closes,1);fn.dispose();
 }finally{globalThis.WebSocket=old;}
});
test('dispose cancels connecting sockets and credential waits; rejects foreign paths',async()=>{
 const old=globalThis.WebSocket;globalThis.WebSocket=Socket;
 try {const fn=createTianaFunctions({connection:async id=>grant(id)});
 for(const path of ['https://other.test/','//other.test/','https://user@fn.example.test/'])await assert.rejects(fn.websocket('a',path),TypeError);
 const a=await connect(fn);const failure=assert.rejects(a.result,{name:'AbortError'});fn.dispose();await failure;assert.equal(a.socket.closes,1);
 let release;const gate=new Promise(r=>release=r);const waiting=createTianaFunctions({connection:async id=>{await gate;return grant(id)}});const pending=waiting.websocket('a','/');const rejected=assert.rejects(pending,{name:'AbortError'});waiting.dispose();await rejected;release();
 }finally{globalThis.WebSocket=old;}
});
test('handshake failures reuse grants until expiry and constructor errors never expose token URLs',async()=>{
 const old=globalThis.WebSocket,clock=Date.now;let now=clock();Date.now=()=>now;globalThis.WebSocket=Socket;
 try{let issued=0;const fn=createTianaFunctions({connection:async id=>{issued++;return grant(id)}});
 const a=await connect(fn);const failure=assert.rejects(a.result,/handshake/);a.socket.emit('error');await failure;
 now+=61000;const b=await connect(fn);b.socket.emit('open');await b.result;assert.equal(issued,2);fn.dispose();
 globalThis.WebSocket=class {constructor(url){throw new Error(String(url));}};
 const bad=createTianaFunctions({connection:async id=>grant(id)});await assert.rejects(bad.websocket('a','/'),error=>!String(error).includes('secret')&&!String(error).includes('wss:'));bad.dispose();
 }finally{globalThis.WebSocket=old;Date.now=clock;}
});
