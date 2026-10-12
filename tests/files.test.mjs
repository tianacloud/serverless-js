import assert from "node:assert/strict";
import { test } from "node:test";
import { createTianaFiles, TianaFileError } from "../dist/index.js";
const origin = "https://files.example.test";
const api = "https://console.example.test/api/v1/files";
const makeGrant = (n = 1) => ({ token: `file-secret-${n}`, origin, root: "/users/tenant/files/", scope_id: "scope-1", expires_at: Math.floor(Date.now()/1000) + 900, session_url: `${origin}/__tiana/file-storage/session` });
const json = body => Response.json(body);
const auth = { getAccessToken: async () => "account-secret" };
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return { promise, resolve }; };

test("Node management uses account auth and content uses file grant, no cookie or token URL", async () => {
  const calls=[];
  const files=createTianaFiles({apiBaseUrl:api,auth,fetch:async (url,init)=>{
    calls.push(String(url));const h=new Headers(init.headers);
    if(url===`${api}/read-grant`) {assert.equal(h.get("authorization"),"Bearer account-secret");return json(makeGrant());}
    assert.equal(h.get("authorization"),"Bearer file-secret-1");assert.equal(init.credentials,"omit");
    assert.equal(url,`${origin}/users/tenant/files/%E6%8A%A5%E5%91%8A%20%23%2B.txt?_fs_scope=scope-1`);
    return new Response("hello");
  }});
  const url=await files.getUrl("报告 #+.txt");assert.ok(!url.includes("secret"));
  assert.equal(await (await files.get("报告 #+.txt")).text(),"hello");assert.equal(calls.length,2);
  await assert.rejects(files.getUrl("../git/x"),TypeError);
});

test("browser installs once before URLs are released; cancelling one waiter preserves others", async () => {
  const gate=deferred();let requests=0,installs=0;
  const files=createTianaFiles({apiBaseUrl:api,request:async()=>{requests++;return json(makeGrant());},fetch:async(url,init)=>{
    assert.equal(url,makeGrant().session_url);assert.equal(init.credentials,"include");installs++;await gate.promise;return new Response(null,{status:204});
  }});
  const abort=new AbortController();const first=files.getUrl("one",{signal:abort.signal});const second=files.getUrl("two");
  abort.abort();await assert.rejects(first,{name:"AbortError"});gate.resolve();
  assert.match(await second,/\/two\?_fs_scope=/);assert.equal(requests,1);assert.equal(installs,1);
});

test("read refreshes once on expired/missing credential; missing object does not refresh", async () => {
  let grants=0,gets=0;
  const files=createTianaFiles({apiBaseUrl:api,auth,fetch:async(url)=>{
    if(url===`${api}/read-grant`) return json(makeGrant(++grants));
    gets++;return gets===1?new Response("expired",{status:403,headers:{"x-tiana-file-error":"file_grant_expired"}}):new Response("absent",{status:404});
  }});
  await assert.rejects(files.get("gone"),e=>e instanceof TianaFileError && e.status===404);
  assert.equal(grants,2);assert.equal(gets,2);
});

test("browser lost Cookie refresh coalesces simultaneous content failures", async () => {
  let grants=0,installs=0;const firstGate=deferred();let firstReads=0;
  const files=createTianaFiles({apiBaseUrl:api,request:async()=>json(makeGrant(++grants)),fetch:async(url,init)=>{
    if(url===makeGrant().session_url){installs++;return new Response(null,{status:204});}
    assert.equal(new Headers(init.headers).has("authorization"),false);
    if(installs===1){firstReads++;if(firstReads===2)firstGate.resolve();await firstGate.promise;return new Response("missing",{status:403,headers:{"x-tiana-file-error":"file_grant_invalid"}});}
    return new Response("ok");
  }});
  const responses=await Promise.all([files.get("a"),files.get("b")]);
  assert.deepEqual(await Promise.all(responses.map(r=>r.text())),["ok","ok"]);assert.equal(grants,2);assert.equal(installs,2);
});

test("direct multipart upload constrains type, never sends account credentials, complete failure retains ID", async () => {
  let prepared;const calls=[];
  const files=createTianaFiles({apiBaseUrl:api,auth,fetch:async(url,init)=>{
    calls.push(url);
    if(url===`${api}/uploads`){prepared=JSON.parse(init.body);return json({id:"42",path:"a.txt",status:"uploading",completed:false,form:{url:"https://bucket.oss.example.test",fields:{"Content-Type":"text/plain",key:"users/t/files/a.txt",policy:"signed"}}});}
    if(url==="https://bucket.oss.example.test"){
      assert.equal(init.credentials,"omit");assert.equal(new Headers(init.headers).has("authorization"),false);
      assert.equal(init.body.get("file").type,"text/plain");assert.equal(await init.body.get("file").text(),"abc");return new Response(null,{status:201});
    }
    throw new Error("lost complete reply");
  }});
  let uploadID;
  await assert.rejects(files.put("a.txt",new Blob(["abc"],{type:"text/plain"}),{requestId:"req1",overwrite:true,onPrepared:u=>uploadID=u.id}),e=>e.code==="FILE_COMPLETE_UNCERTAIN"&&e.uploadId==="42");
  assert.equal(uploadID,"42");assert.equal(prepared.overwrite,true);assert.equal(prepared.size,3);assert.equal(prepared.request_id,"req1");
  assert.equal(calls.length,3);
});

test("local preview URLs use its same-origin streaming broker without installing cross-site cookies", async () => {
  const files=createTianaFiles({apiBaseUrl:"http://127.0.0.1:4174/_tiana/file-storage",contentBaseUrl:"http://127.0.0.1:4174/_tiana/file-storage/content",request:async()=>assert.fail("no management needed"),fetch:async(url,init)=>{
    assert.equal(url,"http://127.0.0.1:4174/_tiana/file-storage/content?path=a%2Fb.png");assert.equal(init.credentials,"same-origin");return new Response("image");
  }});
  await files.ready();assert.match(await files.getUrl("a/b.png"),/^http:\/\/127/);assert.equal(await(await files.get("a/b.png")).text(),"image");
});

test("clear waits for a pending cookie installation and then removes that scope", async () => {
  const installing=deferred();const reached=deferred();const methods=[];
  const files=createTianaFiles({apiBaseUrl:api,request:async()=>json(makeGrant()),fetch:async(url,init)=>{
    methods.push(init.method);if(init.method==="POST"){reached.resolve();await installing.promise;}return new Response(null,{status:204});
  }});
  const ready=files.ready();await reached.promise;const clear=files.clear();installing.resolve();
  await assert.rejects(ready,{name:"AbortError"});await clear;assert.deepEqual(methods,["POST","DELETE"]);
});
