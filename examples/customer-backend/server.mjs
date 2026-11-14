import {createServer} from 'node:https';
import {readFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createAuthorizationURL, exchangeCode, refreshSession, revokeSession, OAuthError} from '../../dist/oauth-node.js';

const here = dirname(fileURLToPath(import.meta.url));
const origin = process.env.CUSTOMER_ORIGIN;
const config = {managementOrigin:process.env.TIANA_ORIGIN,clientId:process.env.TIANA_CLIENT_ID,clientSecret:process.env.TIANA_CLIENT_SECRET,redirectUri:new URL('/tiana/callback',origin).href};
for(const [key,value] of Object.entries(config)) if(!value) throw new Error(`Missing ${key}`);
const dataDirectory = process.env.CUSTOMER_DATA_DIR ?? resolve(here,'data');
mkdirSync(dataDirectory,{recursive:true,mode:0o700});
const db = new DatabaseSync(resolve(dataDirectory,'sessions.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,snapshot TEXT,notice TEXT);
 CREATE TABLE IF NOT EXISTS attempts(state TEXT PRIMARY KEY,local_session_id TEXT,code_verifier TEXT,return_to TEXT,expires_at INTEGER,consumed_at INTEGER);`);
const cookieName = '__Host-tiana_customer_session';
const locks = new Map();
async function locked(id, action) {
  const previous = locks.get(id) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(action);
  locks.set(id,work);
  try {return await work;} finally {if(locks.get(id) === work) locks.delete(id);}
}
function cookie(req) {return req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName+'='))?.slice(cookieName.length+1);}
function session(req,res,create) {
  let id = cookie(req);
  if(id && db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) return id;
  if(!create) return null;
  id = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(id) VALUES(?)').run(id);
  res.setHeader('Set-Cookie',`${cookieName}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax`);
  return id;
}
function read(id) {const row = db.prepare('SELECT snapshot,notice FROM sessions WHERE id=?').get(id);return {snapshot:row?.snapshot ? JSON.parse(row.snapshot) : null,notice:row?.notice ?? null};}
function save(id,snapshot,notice=null) {db.prepare('UPDATE sessions SET snapshot=?,notice=? WHERE id=?').run(snapshot ? JSON.stringify(snapshot) : null,notice,id);}
function reply(res,status,value) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function back(res,path) {res.writeHead(303,{'Location':path,'Cache-Control':'no-store'});res.end();}
async function body(req) {let value='';for await(const part of req) value+=part;return JSON.parse(value);}
function originalPage(value) {
  if(typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) throw new Error('Invalid return_to');
  if(new URL(value,origin).origin !== origin) throw new Error('Invalid return_to');
  return value;
}
function publicSession(snapshot,notice) {return {connected:!!snapshot,session:snapshot ? {session_id:snapshot.sessionId,access_token:snapshot.accessToken,expires_at:snapshot.expiresAt} : null,notice:notice?{code:notice}:null};}

async function route(req,res) {
  const url = new URL(req.url,origin);
  if(req.method === 'POST' && url.pathname.startsWith('/tiana/') && req.headers.origin !== origin) {reply(res,403,{error:{code:'origin_mismatch'}});return;}
  if(req.method === 'POST' && url.pathname === '/tiana/start') {
    const input = await body(req);let returnTo;
    try{returnTo=originalPage(input.return_to);}catch{reply(res,400,{error:{code:'invalid_return_to'}});return;}
    const id = session(req,res,true);
    await locked(id,async()=>{
      const attempt = createAuthorizationURL(config);
      db.prepare('INSERT INTO attempts(state,local_session_id,code_verifier,return_to,expires_at) VALUES(?,?,?,?,?)').run(attempt.state,id,attempt.codeVerifier,returnTo,Date.now()+600_000);
      reply(res,200,{authorize_url:attempt.authorizeUrl});
    });return;
  }
  if(req.method === 'GET' && url.pathname === '/tiana/callback') {
    const id=session(req,res,false),states=url.searchParams.getAll('state');
    if(!id || states.length!==1) {reply(res,400,{error:{code:'invalid_state'}});return;}
    await locked(id,async()=>{
      const attempt=db.prepare('SELECT * FROM attempts WHERE state=? AND local_session_id=?').get(states[0],id);
      if(!attempt){reply(res,400,{error:{code:'invalid_state'}});return;}
      if(attempt.consumed_at !== null){back(res,attempt.return_to);return;}
      db.prepare('UPDATE attempts SET consumed_at=? WHERE state=?').run(Date.now(),states[0]);
      const previous=read(id).snapshot;
      if(attempt.expires_at<=Date.now()){save(id,previous,'login_required');back(res,attempt.return_to);return;}
      if(url.searchParams.has('error') && url.searchParams.has('code')){save(id,previous,'connection_failed');back(res,attempt.return_to);return;}
      if(url.searchParams.has('error')){save(id,previous,url.searchParams.get('error')==='access_denied'?'cancelled':'login_required');back(res,attempt.return_to);return;}
      if(url.searchParams.getAll('code').length!==1){save(id,previous,'connection_failed');back(res,attempt.return_to);return;}
      let next;
      try {next=await exchangeCode(config,{code:url.searchParams.get('code'),codeVerifier:attempt.code_verifier});save(id,next);}
      catch {save(id,previous,'connection_failed');back(res,attempt.return_to);return;}
      if(previous) {try{await revokeSession(config,previous.refreshToken);}catch{save(id,next,'logout_unconfirmed');}}
      back(res,attempt.return_to);
    });return;
  }
  if(req.method === 'POST' && url.pathname === '/tiana/token') {
    const id=session(req,res,true);
    await locked(id,async()=>{
      let {snapshot,notice}=read(id);
      if(snapshot && snapshot.expiresAt-Date.now()<=30_000) {
        if(snapshot.refreshExpiresAt<=Date.now()){snapshot=null;notice='login_required';save(id,null,notice);}
        else try {snapshot=await refreshSession(config,snapshot.refreshToken);save(id,snapshot,notice);}
        catch(error) {
          save(id,null,'login_required');
          if(error instanceof OAuthError && error.code==='invalid_grant'){reply(res,200,publicSession(null,'login_required'));return;}
          reply(res,error instanceof OAuthError&&error.code==='invalid_client'?502:503,{error:{code:error instanceof OAuthError&&error.code==='invalid_client'?'invalid_client':'connection_failed'}});return;
        }
      }
      reply(res,200,publicSession(snapshot,notice));
      if(notice) save(id,snapshot);
    });return;
  }
  if(req.method === 'POST' && url.pathname === '/tiana/logout') {
    const id=session(req,res,false);if(!id){reply(res,200,{notice:null});return;}
    await locked(id,async()=>{
      const previous=read(id).snapshot;
      db.exec('BEGIN');try{save(id,null);db.prepare('DELETE FROM attempts WHERE local_session_id=?').run(id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
      let notice=null;if(previous){try{await revokeSession(config,previous.refreshToken);}catch{notice='logout_unconfirmed';}}
      reply(res,200,{notice:notice?{code:notice}:null});
    });return;
  }
  if(req.method === 'GET' && url.pathname === '/config.js') {
    res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(`export const managementOrigin=${JSON.stringify(config.managementOrigin)};`);return;
  }
  if(req.method === 'GET') {
    const sdk = url.pathname.startsWith('/sdk/');
    const base = sdk ? resolve(here,'../../dist') : resolve(here,'public');
    const relative = sdk ? url.pathname.slice('/sdk/'.length) : url.pathname.slice(1);
    const file = resolve(base,relative);
    if(!file.startsWith(base+'/') && file!==base){reply(res,404,{error:{code:'not_found'}});return;}
    let bytes,extension=extname(file);
    try{bytes=readFileSync(file);}catch{if(sdk){reply(res,404,{error:{code:'not_found'}});return;}bytes=readFileSync(resolve(base,'index.html'));extension='.html';}
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[extension] ?? 'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);return;
  }
  reply(res,404,{error:{code:'not_found'}});
}
const server=createServer({cert:readFileSync(process.env.CUSTOMER_TLS_CERT),key:readFileSync(process.env.CUSTOMER_TLS_KEY)},(req,res)=>{
  void route(req,res).catch(()=>{if(!res.headersSent) reply(res,503,{error:{code:'connection_failed'}});else res.end();});
});
server.listen(Number(process.env.CUSTOMER_PORT ?? 9443),'0.0.0.0',()=>console.log(`Customer example: ${origin}/workspaces/demo/databases?tab=sql#draft-17`));
