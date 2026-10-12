import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";

let server, browser, page;
before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Capacity errors</title>"); return; }
    if (/^\/dist\/[a-z]+\.js$/.test(req.url)) {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile(new URL(`../..${req.url}`, import.meta.url))); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

for (const [code, message] of [
  ["ACTIVATION_RESOURCE_PRESSURE", "activation resource pressure"],
  ["ACTIVATION_NO_IDLE_POD", "activation has no idle pod"],
  ["ACTIVATION_CAPACITY_UNAVAILABLE", "activation capacity unavailable"],
]) {
  test(`browser capacity ${code} retains diagnostics and never replays writes`, async () => {
    let requests = 0;
    const error = { code, message, retryable: true, request_not_executed: true };
    await page.route("https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.example.test/v1/fetch", async route => {
      requests++;
      await route.fulfill({ status: 503, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ error }) });
    });
    const result = await page.evaluate(async () => {
      const { createTianaFetch, diagnosisOf } = await import("/dist/index.js");
      const origin = "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.example.test";
      const client = createTianaFetch({ origin, tianaToken: `tia_0${"A".repeat(43)}` });
      const response = await client(`${origin}/write`, { method: "POST", body: "one write" });
      return { status: response.status, body: await response.json(), diagnosis: diagnosisOf(response) };
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error });
    assert.ok(result.diagnosis.requestId.startsWith("req-"));
    assert.equal(requests, 1);
    await page.unrouteAll();
  });
}
