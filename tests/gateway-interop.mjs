import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

// Explicit artifact and connection inputs; no adjacent checkout is required.
const { createTianaFetch } = await import(pathToFileURL(process.argv[2]).href);
const config = JSON.parse(await readFile(process.argv[3], "utf8"));
const origin = `https://${config.hostname}`;
const ca = new X509Certificate(Buffer.from(config.certificate_der)).toString();
const tls = {
  host: "127.0.0.1",
  port: config.port,
  servername: config.hostname,
  ca,
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
};

for (const protocol of ["http/1.1", "h2"]) {
  let calls = 0;
  const sessions = [];
  async function transport(input, init) {
    calls += 1;
    const url = new URL(input);
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, "/v1/fetch");
    const body = Buffer.from(await new Response(init.body).arrayBuffer());
    const headers = Object.fromEntries(new Headers(init.headers));
    assert.equal(headers.authorization, `Bearer tia_0${"A".repeat(43)}`);
    return new Promise((resolve, reject) => {
      let request;
      if (protocol === "h2") {
        const session = http2.connect(origin, { ...tls, ALPNProtocols: ["h2"] });
        sessions.push(session);
        session.on("error", reject);
        session.once("connect", () => assert.equal(session.alpnProtocol, "h2"));
        request = session.request({
          ...headers,
          ":method": init.method,
          ":path": url.pathname,
          ":authority": config.hostname,
          ":scheme": "https",
        });
        request.once("response", (responseHeaders) => {
          const status = responseHeaders[":status"];
          const responseFields = Object.fromEntries(
            Object.entries(responseHeaders).filter(([name]) => !name.startsWith(":")),
          );
          resolve(new Response(Readable.toWeb(request), { status, headers: responseFields }));
        });
      } else {
        request = https.request({
          ...tls,
          ALPNProtocols: ["http/1.1"],
          method: init.method,
          path: url.pathname,
          headers: { ...headers, host: config.hostname, "content-length": body.length },
          agent: false,
        }, (response) => {
          assert.equal(response.socket.alpnProtocol, "http/1.1");
          assert.equal(response.headers.connection, "close");
          resolve(new Response(Readable.toWeb(response), {
            status: response.statusCode,
            headers: response.headers,
          }));
        });
      }
      request.on("error", reject);
      init.signal?.addEventListener("abort", () => request.destroy(), { once: true });
      request.end(body);
    });
  }
  const adapter = createTianaFetch({
    origin,
    tianaToken: `tia_0${"A".repeat(43)}`,
    fetch: transport,
  });
  try {
    const response = await adapter(`${origin}/v1/query?x=1`, {
      headers: { authorization: "Bearer db-test" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(await response.text(), '{"ok":1}');
    assert.equal(calls, 1);
    await assert.rejects(async () => {
      const truncated = await adapter(`${origin}/v1/query?x=1`, {
        headers: { authorization: "Bearer db-test" },
      });
      await truncated.text();
    });
    assert.equal(calls, 2, "postcommit failure must not replay");
    console.log(`${protocol}: SDK/Gateway success, credential separation, postcommit abort, no replay PASS`);
  } finally {
    for (const session of sessions) session.destroy();
  }
}
await new Promise((resolve, reject) => {
  const socket = net.connect(config.done_port, "127.0.0.1", () => socket.end());
  socket.on("error", reject);
  socket.on("close", resolve);
});
