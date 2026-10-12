// Run against an isolated TLS peer; this does not assert deployed Gateway behavior.
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTianaFetch, diagnosisOf } from "../dist/index.js";
import { decodeRequestFrameBytes, encodeResponseFrameBytes } from "../dist/codec.js";

const origin = "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.db.example.test";
const token = `tia_0${"A".repeat(42)}A`;
const scenarios = ["abort", "cancel", "truncate", "disconnect", "recovery"];

async function client(peer) {
  const rows = [];
  for (const protocol of ["hrana", "tiana-http"]) {
    for (const mode of ["buffered", "stream"]) {
      const ids = new Set();
      for (const scenario of scenarios) {
        const events = [];
        const controller = new AbortController();
        let wireId, response, failure, streaming;
        const adapter = createTianaFetch({
          origin, tianaToken: token, requestBodyMode: mode,
          ...(protocol === "tiana-http" ? { protocol } : {}),
          onDiagnostic(event) { events.push(event); },
          fetch(_url, init) {
            wireId = new Headers(init.headers).get("x-request-id");
            assert.equal(events[0].requestId, wireId);
            streaming = init.body instanceof ReadableStream;
            return fetch(peer, init);
          },
        });
        const request = new Request(`${origin}/${scenario}`, {
          method: "POST", body: "{}", signal: controller.signal,
        });
        try {
          response = await adapter(request);
          if (scenario === "abort") controller.abort();
          if (scenario === "cancel") await response.body.cancel("caller cancelled");
          else if (scenario === "recovery") assert.equal(await response.text(), "hello");
          else await response.text();
        } catch (error) { failure = error; }
        const expected = ["abort", "cancel"].includes(scenario) ? "cancelled"
          : scenario === "recovery" ? "completed" : "failed";
        assert.equal(events.at(-1).phase, expected, `${protocol}/${mode}/${scenario}: ${failure}; cause=${failure?.cause}`);
        assert.equal(diagnosisOf(request).requestId, wireId);
        assert.equal(diagnosisOf(response).requestId, wireId);
        assert.equal(diagnosisOf(response).phase, expected);
        assert.ok(events.every(event => event.requestId === wireId));
        assert.equal(events.filter(event => ["completed", "failed", "cancelled"].includes(event.phase)).length, 1);
        assert.ok(!ids.has(wireId)); ids.add(wireId);
        if (["abort", "truncate", "disconnect"].includes(scenario)) {
          assert.ok(failure);
          assert.equal(diagnosisOf(failure).requestId, wireId);
        } else assert.equal(failure, undefined);
        assert.equal(streaming, protocol === "hrana" && mode === "stream");
        rows.push({ protocol, mode, scenario, phase: expected, request_id: wireId,
          actual_request_stream: streaming, passed: true });
      }
    }
  }
  console.log(JSON.stringify({ runtime: process.versions, rows }));
}

async function run() {
  const directory = await mkdtemp(join(tmpdir(), "tiana-native-response-"));
  let server;
  const received = [];
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(directory, "ca-key.pem"), "-out", join(directory, "ca.pem"),
      "-days", "1", "-subj", "/CN=Diagnostic Test CA", "-addext", "basicConstraints=critical,CA:TRUE"],
    { stdio: "ignore" });
    execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "leaf.csr"),
      "-subj", "/CN=localhost"], { stdio: "ignore" });
    await writeFile(join(directory, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    execFileSync("openssl", ["x509", "-req", "-in", join(directory, "leaf.csr"),
      "-CA", join(directory, "ca.pem"), "-CAkey", join(directory, "ca-key.pem"), "-CAcreateserial",
      "-out", join(directory, "cert.pem"), "-days", "1", "-extfile", join(directory, "leaf.ext")], { stdio: "ignore" });
    server = createServer({ key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")) }, async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = decodeRequestFrameBytes(Buffer.concat(chunks));
        const id = req.headers["x-request-id"];
        assert.equal(request.metadata.request_id, id);
        const scenario = request.metadata.path_query.slice(1);
        received.push({ request_id: id, scenario, protocol: request.metadata.protocol ?? "hrana" });
        const body = new TextEncoder().encode("hello");
        const frame = new Uint8Array(encodeResponseFrameBytes({ metadata_version: 1,
          request_id: id, status: 200, status_text: "OK", headers: [], body_length: body.length }, body));
        res.writeHead(200, { "content-type": "application/vnd.tiana.fetch.v1", "cache-control": "no-store" });
        if (scenario === "recovery") { res.end(frame); return; }
        if (scenario === "truncate") { res.end(frame.subarray(0, frame.length - 1)); return; }
        res.write(frame.subarray(0, frame.length - 1));
        const timer = setTimeout(() => scenario === "disconnect" ? res.destroy() : res.end(frame.subarray(frame.length - 1)),
          scenario === "disconnect" ? 250 : 5000);
        res.on("close", () => clearTimeout(timer));
      } catch (error) { res.destroy(error); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const peer = `https://127.0.0.1:${server.address().port}`;
    const runtimes = process.env.TIANA_TEST_ONLY === "deno" ? [] : [{ name: "node", command: process.execPath, args: [] }];
    if (process.env.TIANA_TEST_BUN) runtimes.push({ name: "bun", command: process.env.TIANA_TEST_BUN, args: [] });
    if (process.env.TIANA_TEST_DENO) runtimes.push({ name: "deno", command: process.env.TIANA_TEST_DENO,
      args: ["run", "--allow-read", "--allow-env", "--allow-net", "--cert", join(directory, "ca.pem"), "--node-modules-dir=manual"] });
    for (const runtime of runtimes) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy/i.test(key)));
      Object.assign(env, { NODE_EXTRA_CA_CERTS: join(directory, "ca.pem"), DENO_CERT: join(directory, "ca.pem") });
      const result = await new Promise((resolve, reject) => {
        const child = spawn(runtime.command, [...runtime.args, fileURLToPath(import.meta.url), "--client", peer], { env });
        let out = "", err = "";
        child.stdout.on("data", data => { out += data; });
        child.stderr.on("data", data => { err += data; });
        child.on("error", reject);
        child.on("exit", code => resolve({ code, out, err }));
      });
      assert.equal(result.code, 0, `${runtime.name}: ${result.err}`);
      const parsed = JSON.parse(result.out);
      for (const row of parsed.rows) assert.equal(received.filter(item => item.request_id === row.request_id).length, 1);
      console.log(JSON.stringify({ name: runtime.name, ...parsed, wire_ids_matched: true }));
    }
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--client") await client(process.argv[3]);
else await run();
