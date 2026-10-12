// Explicit independently built SDK and real Gateway connection inputs.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import http2 from "node:http2";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
const { createTianaFetch } = await import(pathToFileURL(process.argv[2]).href);
const config = JSON.parse(await readFile(process.argv[3], "utf8"));
const origin = `https://${config.hostname}`;
const tls = { host: "127.0.0.1", port: config.port, servername: config.hostname,
  ca: new X509Certificate(Buffer.from(config.certificate_der)).toString(),
  minVersion: "TLSv1.3", maxVersion: "TLSv1.3" };
for (const protocol of ["http/1.1", "h2"]) {
  const sessions = [];
  async function transport(input, init) {
    const url = new URL(input);
    const body = Buffer.from(await new Response(init.body).arrayBuffer());
    const headers = Object.fromEntries(new Headers(init.headers));
    return new Promise((resolve, reject) => {
      let request;
      if (protocol === "h2") {
        const session = http2.connect(origin, { ...tls, ALPNProtocols: ["h2"] });
        sessions.push(session); session.on("error", reject);
        request = session.request({ ...headers, ":method": init.method, ":path": url.pathname,
          ":authority": config.hostname, ":scheme": "https" });
        request.once("response", fields => resolve(new Response(Readable.toWeb(request), {
          status: fields[":status"], headers: Object.fromEntries(Object.entries(fields).filter(([name]) => !name.startsWith(":")))
        })));
      } else {
        request = https.request({ ...tls, ALPNProtocols: ["http/1.1"], method: init.method,
          path: url.pathname, headers: { ...headers, host: config.hostname, "content-length": body.length }, agent: false },
          response => resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })));
      }
      request.on("error", reject);
      init.signal?.addEventListener("abort", () => request.destroy(init.signal.reason), { once: true });
      request.end(body);
    });
  }
  const adapter = createTianaFetch({ origin, tianaToken: `tia_0${"A".repeat(43)}`, protocol: "tiana-http", fetch: transport });
  async function sql(sql) {
    const response = await adapter(`${origin}/v1/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql }) });
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    const result = await sql("CREATE TABLE IF NOT EXISTS http_demo(v INTEGER); INSERT INTO http_demo VALUES(42); SELECT v FROM http_demo;");
    assert.equal(result.ok, true);
    assert.equal(result.results.at(-1).result.rows[0][0], "42");
    assert.equal((await sql("SELECT missing_column FROM http_demo;")).ok, false);
    assert.equal((await adapter(`${origin}/not-an-app-route`)).status, 404);
    assert.equal((await sql("BEGIN; INSERT INTO http_demo VALUES(43); COMMIT;")).ok, true);
    assert.equal((await sql("CREATE TEMP TABLE request_private(v);")).ok, true);
    assert.equal((await sql("SELECT * FROM request_private;")).ok, false);
    const native = createTianaFetch({ origin, tianaToken: `tia_0${"A".repeat(43)}`, fetch: transport });
    const response = await native(`${origin}/v3/pipeline`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: "SELECT 42" } }, { type: "close" }] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].type, "ok");
    const times = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now(); assert.equal((await sql("SELECT 1")).ok, true); times.push(performance.now() - started);
    }
    times.sort((a,b) => a-b);
    console.log(JSON.stringify({ transport: protocol, samples: times.length, warm_request_ms: { p50: times[49], p95: times[94], max: times.at(-1) }, result: "PASS" }));
  } finally { for (const session of sessions) session.destroy(); }
}
