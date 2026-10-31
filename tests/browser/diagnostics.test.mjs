import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createSecureServer } from "node:http2";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { decodeRequestFrameBytes, encodeResponseFrameBytes } from "../../dist/codec.js";

const host = "ep-01j5c9m7q2v8x4k6n3r0t1w2yz.gateway.localhost";
const rejectedHost = "ep-01j5c9m7q2v8x4k6n3r0t1w2yx.gateway.localhost";
const missingHost = "ep-01j5c9m7q2v8x4k6n3r0t1w2yw.gateway.localhost";
const token = `tia_0${"A".repeat(42)}A`;
const requests = new Map();
let root, server, browser, page, origin;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "tiana-sdk-browser-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1",
    "-subj", "/CN=localhost"], { stdio: "ignore" });
  server = createSecureServer({
    key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")),
    allowHTTP1: true,
  });
  server.on("request", (req, res) => { handle(req, res).catch(() => res.destroy()); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `https://${host}:${server.address().port}`;
  browser = await chromium.launch({ args: [
    `--host-resolver-rules=MAP ${host} 127.0.0.1,MAP ${rejectedHost} 127.0.0.1,MAP ${missingHost} ~NOTFOUND`,
    "--no-proxy-server",
  ] });
  page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(`https://127.0.0.1:${server.address().port}/`);
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

async function handle(req, res) {
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Customer SDK diagnostic test</title>");
    return;
  }
  if (/^\/dist\/[a-z]+\.js$/.test(req.url)) {
    res.setHeader("content-type", "text/javascript");
    res.end(await readFile(new URL(`../..${req.url}`, import.meta.url)));
    return;
  }
  if (req.url.startsWith("/api/v1/auth/")) {
    const id = req.headers["x-request-id"];
    requests.set(id, { path: req.url, protocol: req.httpVersion });
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/whoami")) {
      res.end(JSON.stringify({ sync_status: "complete" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (body.refresh_token === "reject-refresh") {
      res.writeHead(401); res.end("{}"); return;
    }
    res.end(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh",
      expires_in: 3600, refresh_expires_at: new Date(Date.now()+86400000).toISOString(),
      token_type: "Bearer", sync_status: "pending" }));
    return;
  }
  if (req.headers[":authority"]?.startsWith(rejectedHost) || req.headers.host?.startsWith(rejectedHost)) {
    res.writeHead(403); res.end(); return;
  }
  res.setHeader("access-control-allow-origin", `https://127.0.0.1:${server.address().port}`);
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, cache-control, content-type, x-request-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const { metadata } = decodeRequestFrameBytes(Buffer.concat(chunks));
  const id = req.headers["x-request-id"];
  requests.set(id, { metadataId: metadata.request_id, path: metadata.path_query, protocol: req.httpVersion });
  const scenario = metadata.path_query.slice(1);
  if (scenario === "network") { req.socket.destroy(); return; }
  res.setHeader("cache-control", "no-store");
  if (scenario === "outer") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end((await readFile(new URL("../fixtures/fetch/error-unavailable.json", import.meta.url), "utf8")).trimEnd());
    return;
  }
  const body = new TextEncoder().encode("hello");
  const frame = new Uint8Array(encodeResponseFrameBytes({
    metadata_version: 1, request_id: id, status: scenario === "inner" ? 500 : 200,
    status_text: scenario === "inner" ? "Internal Server Error" : "OK",
    headers: [{ name: "content-type", value: "text/plain" }], body_length: body.length,
  }, body));
  res.writeHead(200, { "content-type": "application/vnd.tiana.fetch.v1" });
  if (["abort", "cancel"].includes(scenario)) {
    res.write(frame.subarray(0, frame.length - 1));
    const timer = setTimeout(() => res.end(frame.subarray(frame.length - 1)), 2000);
    res.on("close", () => clearTimeout(timer));
  } else {
    res.end(scenario === "truncate" ? frame.subarray(0, frame.length - 1) : frame);
  }
}

async function run(scenario, mode, targetPage = page, targetOrigin = origin) {
  return targetPage.evaluate(async ({ origin, token, scenario, mode }) => {
    const { createTianaFetch, diagnosisOf } = await import("/dist/index.js");
    const events = [];
    const controller = new AbortController();
    const client = createTianaFetch({ origin, tianaToken: token, requestBodyMode: mode,
      onDiagnostic(event) { events.push(event); if (scenario === "observer") throw Error("observer"); },
    });
    const input = new Request(`${origin}/${scenario}`, { signal: controller.signal });
    if (scenario === "preabort") controller.abort("before network");
    let response, error;
    try {
      response = await client(input);
      if (scenario === "abort") controller.abort();
      if (scenario === "cancel") await response.body.cancel("user cancelled");
      else await response.text();
    } catch (caught) { error = caught; }
    return { events, request: diagnosisOf(input), response: diagnosisOf(response),
      error: diagnosisOf(error), errorName: error?.name, errorMessage: error?.message, status: response?.status };
  }, { origin: targetOrigin, token, scenario, mode });
}

for (const mode of ["buffered", "stream"]) {
  for (const scenario of ["success", "observer", "outer", "inner", "truncate", "network", "abort", "cancel", "preabort"]) {
    test(`${mode}: browser ${scenario} retains the request identity`, async () => {
      const result = await run(scenario, mode);
      const id = result.events[0].requestId;
      assert.ok(id.startsWith("req-"));
      assert.ok(result.events.every(event => event.requestId === id));
      assert.equal(result.request.requestId, id);
      if (scenario === "preabort") assert.equal(requests.has(id), false);
      else assert.equal(requests.get(id)?.metadataId, id);
      if (result.response) assert.equal(result.response.requestId, id);
      if (result.error) assert.equal(result.error.requestId, id);
      const expected = ["truncate", "network"].includes(scenario) ? "failed"
        : ["abort", "cancel", "preabort"].includes(scenario) ? "cancelled" : "completed";
      assert.equal(result.events.at(-1).phase, expected, result.errorMessage);
      if (scenario === "outer") assert.equal(result.status, 503);
      if (scenario === "inner") assert.equal(result.status, 500);
      if (mode === "stream" && scenario !== "preabort") assert.equal(requests.get(id).protocol, "2.0");
    });
  }
}

test("browser CORS rejection preserves an ID before any gateway POST", async () => {
  const result = await run("success", "buffered", page, origin.replace(host, rejectedHost));
  assert.equal(result.events.at(-1).phase, "failed");
  assert.equal(result.error.requestId, result.request.requestId);
  assert.equal(requests.has(result.request.requestId), false);
});

test("browser DNS failure preserves an ID before ingress", async () => {
  const failed = page.waitForEvent("requestfailed", request => request.url().includes(missingHost));
  const result = await run("success", "buffered", page, origin.replace(host, missingHost));
  assert.match((await failed).failure().errorText, /ERR_NAME_NOT_RESOLVED/);
  assert.equal(result.events.at(-1).phase, "failed");
  assert.equal(result.error.requestId, result.request.requestId);
  assert.equal(requests.has(result.request.requestId), false);
});

test("browser TLS rejection preserves an ID before ingress", async () => {
  const pages = createServer((req, res) => { handle(req, res).catch(() => res.destroy()); });
  await new Promise(resolve => pages.listen(0, "127.0.0.1", resolve));
  const strict = await browser.newPage({ ignoreHTTPSErrors: false });
  try {
    await strict.goto(`http://127.0.0.1:${pages.address().port}/`);
    const failed = strict.waitForEvent("requestfailed", request => request.url().startsWith(origin));
    const result = await run("success", "buffered", strict);
    assert.match((await failed).failure().errorText, /ERR_CERT_/);
    assert.equal(result.events.at(-1).phase, "failed");
    assert.equal(result.error.requestId, result.request.requestId);
    assert.equal(requests.has(result.request.requestId), false);
  } finally {
    await strict.close();
    await new Promise(resolve => pages.close(resolve));
  }
});

test("concurrent browser requests keep separate identities", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => run("success", "buffered")));
  assert.equal(new Set(results.map(result => result.request.requestId)).size, 20);
  for (const result of results) {
    assert.equal(result.response.requestId, result.request.requestId);
    assert.equal(requests.get(result.request.requestId).metadataId, result.request.requestId);
  }
});

for (const reject of [false, true]) {
  test(`browser session provider ${reject ? "rejection" : "refresh and readiness"} retains wire IDs`, async () => {
    const result = await page.evaluate(async reject => {
      const { createTianaSessionAuth, diagnosisOf } = await import("/dist/index.js");
      const events = [];
      const auth = createTianaSessionAuth({ managementOrigin: location.origin,
        credentials: {accessToken:"old-access", refreshToken:reject?"reject-refresh":"old-refresh",
          expiresAt:1, refreshExpiresAt:Date.now()+86400000},
        onDiagnostic: event => events.push(event) });
      try { return { token: await auth.getAccessToken(), events }; }
      catch (error) { return { error: diagnosisOf(error), events }; }
    }, reject);
    const started = result.events.filter(event => event.phase === "request_started");
    assert.equal(started.length, reject ? 1 : 2);
    for (const event of started) assert.ok(requests.has(event.requestId));
    assert.equal(new Set(started.map(event => event.requestId)).size, started.length);
    if (reject) {
      assert.equal(result.error.requestId, started[0].requestId);
      assert.equal(result.error.phase, "failed");
    } else {
      assert.equal(result.token, "new-access");
      assert.equal(result.events.filter(event => event.phase === "completed").length, 2);
    }
    assert.ok(!JSON.stringify(result.events).includes("refresh_token"));
  });
}
