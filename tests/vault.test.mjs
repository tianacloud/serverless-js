import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVaultSigner,createTianaVault,VaultError} from '../dist/index.js';

test('Vault HMAC agrees with the Rust and Go canonical vector',async()=>{
 const signer=await createVaultSigner(Buffer.alloc(16,42).toString('base64url'));
 const headers=await signer('vault-test','production/db',100);
 assert.equal(headers.get('x-tiana-vault-signature'),'04ReeK28HTm2Gpj5pH10mHEmJZfb0HdN679BOrOetsg=');
 assert.equal(headers.get('x-tiana-vault-time'),'100');
 assert.notEqual((await signer('vault-test','production/other',100)).get('x-tiana-vault-signature'),headers.get('x-tiana-vault-signature'));
});
test('Vault operations encode keys once and retain values and exact version metadata',async()=>{
 const requests=[];
 const vault=createTianaVault({instanceId:'vault-test',origin:'https://example.test',fetch:async(url,init)=>{
  requests.push({url:String(url),...init});
  if(init.method==='DELETE')return new Response(null,{status:204});
  return Response.json(init.method==='PUT'?{key:'a/%?#',version:'9223372036854775807',changed:true}:{key:'a/%?#',version:'1',value:''});
 }});
 const set=await vault.Set('a/%?#',' \n '); assert.equal(set.version,'9223372036854775807');
 assert.equal(JSON.parse(requests[0].body).value,' \n '); assert.equal(new URL(requests[0].url).pathname,'/secrets/a%2F%25%3F%23');
 const signer=await createVaultSigner(Buffer.alloc(16,42).toString('base64url'));
 assert.equal((await vault.Get('a/%?#',signer)).value,''); assert.ok(requests[1].headers.get('x-tiana-vault-signature'));
 await vault.Remove('a/%?#'); assert.equal(requests.length,3);
});
test('Vault reports signature expiry without retry or peer message',async()=>{
 let calls=0;
 const vault=createTianaVault({instanceId:'vault-test',origin:'https://example.test',fetch:async()=>{calls++;return Response.json({error:{code:'SIGNATURE_EXPIRED',message:'synthetic-secret'}},{status:403});}});
 const signer=await createVaultSigner(Buffer.alloc(16,42).toString('base64url'));
 await assert.rejects(vault.Get('key',signer),e=>e instanceof VaultError&&e.code==='SIGNATURE_EXPIRED'&&!e.message.includes('synthetic-secret'));
 assert.equal(calls,1);
});
