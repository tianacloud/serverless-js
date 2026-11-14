import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createAuthorizationURL, exchangeCode, refreshSession, revokeSession} from '../dist/oauth-node.js';
const config={managementOrigin:'https://console.test',clientId:'client',clientSecret:'a_secret-raw',redirectUri:'https://customer.test/callback?from=tiana'};
test('authorization URL binds random state and S256 verifier; secret is absent',()=>{
  const a=createAuthorizationURL(config),b=createAuthorizationURL(config),url=new URL(a.authorizeUrl);
  assert.notEqual(a.state,b.state);assert.notEqual(a.codeVerifier,b.codeVerifier);
  assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(a.codeVerifier).digest('base64url'));
  assert.equal(url.searchParams.get('state'),a.state);assert.equal(url.searchParams.get('redirect_uri'),config.redirectUri);
  assert.ok(!a.authorizeUrl.includes(config.clientSecret));
});
test('server helpers send raw-secret SHA256 digest and return whole snapshots',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url:String(url),init});return String(url).endsWith('/revoke')?new Response(null):Response.json({session_id:'s',access_token:'at',refresh_token:'rt',expires_in:604800,refresh_expires_in:2592000});});
  const started=Date.now();const snapshot=await exchangeCode(config,{code:'code',codeVerifier:'verifier'});
  assert.ok(snapshot.refreshExpiresAt>=started+2592000000);assert.equal(snapshot.sessionId,'s');assert.ok(snapshot.expiresAt>=started+604800000);
  assert.equal(Buffer.from(calls[0].init.headers.Authorization.slice(6),'base64').toString(),`client:${createHash('sha256').update(config.clientSecret).digest('hex')}`);
  assert.equal(calls[0].init.body.get('code_verifier'),'verifier');
  await refreshSession(config,'rt');assert.equal(calls[1].init.body.get('refresh_token'),'rt');
  await revokeSession(config,'rt');assert.equal(calls[2].init.body.get('token'),'rt');
});
test('lost refresh is sent once and delivered to the customer',async t=>{
  const failure=new Error('lost');let n=0;
  t.mock.method(globalThis,'fetch',async()=>{n++;throw failure;});
  await assert.rejects(refreshSession(config,'rt'),e=>e===failure);assert.equal(n,1);
});
