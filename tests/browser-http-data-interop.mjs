// Run against a real Gateway/Agent/App fixture with an explicitly supplied Playwright install.
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";
const config = JSON.parse(await readFile(process.argv[3], "utf8"));
const dist = path.dirname(path.resolve(process.argv[2]));
const playwright = await import(pathToFileURL(process.env.TIANA_PLAYWRIGHT_MODULE).href);
const pageServer = http.createServer(async (req,res) => {
  if (req.url === "/") { res.setHeader("content-type","text/html"); res.end("<!doctype html><title>HTTP data integration</title>"); return; }
  const name = path.basename(req.url);
  try { res.setHeader("content-type","text/javascript"); res.end(await readFile(path.join(dist,name))); }
  catch { res.statusCode=404;res.end(); }
});
const proxy = http.createServer((req,res) => {res.statusCode=502;res.end();});
proxy.on("connect",(req,client,head) => {
  if (req.url !== `${config.hostname}:443`) { client.destroy(); return; }
  const upstream=net.connect(config.port,"127.0.0.1",()=>{
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if(head.length) upstream.write(head);
    client.pipe(upstream);upstream.pipe(client);
  });
  upstream.on("error",()=>client.destroy());client.on("error",()=>upstream.destroy());
  client.on("close",()=>upstream.destroy());upstream.on("close",()=>client.destroy());
});
await new Promise(resolve=>pageServer.listen(0,"127.0.0.1",resolve));
await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));
const results=[];
try {
 for (const name of ["chromium","firefox","webkit"]) {
  let browser;
  try {
   browser=await playwright[name].launch({headless:true,proxy:{server:`http://127.0.0.1:${proxy.address().port}`,bypass:"127.0.0.1,localhost"}});
   const context=await browser.newContext({ignoreHTTPSErrors:true});
   const page=await context.newPage();
   await page.goto(`http://127.0.0.1:${pageServer.address().port}/`);
   const result=await page.evaluate(async config=>{
    const {createTianaFetch}=await import('/index.js');
    const origin=`https://${config.hostname}`;
    const options={origin,tianaToken:`tia_${'A'.repeat(43)}`,protocol:'tiana-http'};
    const adapter=createTianaFetch(options);
    const query=sql=>adapter(`${origin}/v1/sql`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sql})});
    const response=await query("CREATE TABLE IF NOT EXISTS browser_demo(v TEXT); INSERT INTO browser_demo VALUES('你好'); SELECT v FROM browser_demo;");
    const result=await response.json();
    if(response.status!==200 || !result.ok || result.results.at(-1).result.rows[0][0]!=='你好') throw Error('SQL result mismatch');
    if((await adapter(`${origin}/arbitrary-app-path`)).status!==404) throw Error('App path not passed through');
    const broken=createTianaFetch({...options,fetch:(url,init)=>{const headers=new Headers(init.headers);headers.delete('authorization');return fetch(url,{...init,headers});}});
    const error=await broken(`${origin}/v1/sql`);const body=await error.json();
    if(error.status===200 || !body.error) throw Error('platform error unreadable');
    const abort=new AbortController();abort.abort();
    let cancelled=false;
    try {await adapter(`${origin}/v1/sql`,{method:'POST',body:'{}',signal:abort.signal});} catch(e) {cancelled=e.name==='AbortError';}
    if(!cancelled) throw Error('cancellation failed');
    const runningAbort=new AbortController();
    const running=adapter(`${origin}/v1/sql`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({sql:'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n;'}),signal:runningAbort.signal});
    setTimeout(()=>runningAbort.abort(),50);
    let inFlightCancelled=false;
    try {await (await running).text();} catch(e) {inFlightCancelled=e.name==='AbortError';}
    if(!inFlightCancelled) throw Error('in-flight cancellation failed');
    const concurrent=await Promise.all(Array.from({length:4},async()=>{
      const result=await (await query('SELECT 42;')).json();
      return result.ok && result.results[0].result.rows[0][0]==='42';
    }));
    if(!concurrent.every(Boolean)) throw Error('concurrent requests after cancellation failed');
    return {sql:true,app_status:404,platform_error_status:error.status,cancelled,inFlightCancelled,concurrent:4};
   },config);
   results.push({browser:name,version:browser.version(),result:'PASS',...result});
  } catch(error) {results.push({browser:name,result:'FAIL',error:String(error)});}
  finally {await browser?.close();}
 }
} finally {pageServer.close();proxy.close();}
console.log(JSON.stringify(results,null,2));
if(results.some(r=>r.result!=='PASS'))process.exitCode=1;
