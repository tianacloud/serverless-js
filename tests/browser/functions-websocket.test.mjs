import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from '@playwright/test';

test('browser native Function socket opens and exposes messages and close', async () => {
 const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.end('<!doctype html><title>Functions</title>');return;}
  res.setHeader('content-type','text/javascript');res.end(await readFile(new URL('../..'+req.url,import.meta.url)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  browser=await chromium.launch();const page=await browser.newPage();let seen;
  await page.routeWebSocket('wss://fn.example.test/**', ws=>{seen=ws.url();ws.onMessage(message=>ws.send(message));});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await page.evaluate(async()=>{
   const {createTianaFunctions}=await import('/dist/index.js');
   const fn=createTianaFunctions({connection:async id=>({instance_id:id,origin:'https://fn.example.test',token:'browser+/=',expires_at:Math.floor(Date.now()/1000)+60})});
   const abort=new AbortController();const socket=await fn.websocket('fn','/chat?topic=hello',{protocols:['chat'],signal:abort.signal});
   abort.abort();const message=new Promise(resolve=>socket.addEventListener('message',event=>resolve(event.data),{once:true}));socket.send('hello');
   const value=await message;const closed=new Promise(resolve=>socket.addEventListener('close',()=>resolve(true),{once:true}));fn.dispose();
   return {native:socket instanceof WebSocket,value,closed:await closed};
  });
  assert.deepEqual(result,{native:true,value:'hello',closed:true});assert.equal(new URL(seen).searchParams.get('access_token'),'browser+/=');assert.equal(new URL(seen).searchParams.get('topic'),'hello');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
