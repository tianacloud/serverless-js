import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeRequestFrameBytes,
  encodeResponseFrameBytes,
} from "../dist/codec.js";
import {
  createTianaFetch,
  TianaFetchProtocolError,
} from "../dist/index.js";

const origin =
  "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.db.service.internal.tiana.com";
const tianaToken = `tia_${"A".repeat(42)}A`;
const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));
const maxBodyBytes = 16 << 20;

async function requestBytes(init) {
  return new Uint8Array(await new Response(init.body).arrayBuffer());
}

function successFrame(request, overrides = {}) {
  const body = new TextEncoder().encode('{"ok":1}');
  const metadata = {
    metadata_version: 1,
    request_id: request.metadata.request_id,
    status: 201,
    status_text: "Created",
    headers: [
      { name: "content-type", value: "application/json" },
      { name: "set-cookie", value: "a=1" },
      { name: "set-cookie", value: "b=2" },
    ],
    body_length: body.byteLength,
    ...overrides,
  };
  return encodeResponseFrameBytes(metadata, body);
}

function successResponse(frame) {
  return new Response(frame, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/vnd.tiana.fetch.v1",
    },
  });
}

test("adapter normalizes one request, emits TFQ1 once, and returns inner Response", async () => {
  let calls = 0;
  let captured;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(input, init) {
      calls += 1;
      captured = { input, init };
      const request = decodeRequestFrameBytes(await requestBytes(init));
      assert.equal(request.metadata.path_query, "/v2/pipeline?x=1");
      assert.equal(request.metadata.method, "POST");
      assert.equal(request.metadata.body_length, null);
      assert.match(
        request.metadata.request_id,
        /^req-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.deepEqual(request.body, new TextEncoder().encode('{"q":1}'));
      assert.ok(
        request.metadata.headers.some(
          ({ name, value }) => name === "authorization" && value === "Bearer db-test",
        ),
      );
      assert.ok(
        request.metadata.headers.every(({ value }) => !value.includes(tianaToken)),
      );
      return successResponse(successFrame(request));
    },
  });

  const response = await adapter(new URL(`${origin}/v2/pipeline?x=1`), {
    method: "POST",
    headers: {
      authorization: "Bearer db-test",
      "content-type": "application/json",
    },
    body: '{"q":1}',
  });

  assert.equal(calls, 1);
  assert.equal(captured.input, `${origin}/v1/fetch`);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.cache, "no-store");
  assert.equal(captured.init.credentials, "omit");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.duplex, "half");
  assert.equal(captured.init.headers.get("authorization"), `Bearer ${tianaToken}`);
  assert.equal(captured.init.headers.get("cache-control"), "no-store");
  assert.equal(
    captured.init.headers.get("content-type"),
    "application/vnd.tiana.fetch.v1",
  );
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.url, `${origin}/v2/pipeline?x=1`);
  assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal(await response.text(), '{"ok":1}');
});

test("adapter streams an unknown-length Request body in order", async () => {
  const chunks = [
    new TextEncoder().encode("first-"),
    new TextEncoder().encode("second"),
  ];
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(next);
      }
    },
  });
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      const request = decodeRequestFrameBytes(await requestBytes(init));
      assert.equal(request.metadata.body_length, null);
      assert.equal(new TextDecoder().decode(request.body), "first-second");
      return successResponse(successFrame(request));
    },
  });
  const response = await adapter(`${origin}/v1/query`, {
    method: "POST",
    body,
    duplex: "half",
  });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), '{"ok":1}');
});

test("Request input plus RequestInit uses native Fetch override semantics", async () => {
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      const request = decodeRequestFrameBytes(await requestBytes(init));
      assert.equal(request.metadata.method, "PUT");
      assert.equal(request.metadata.path_query, "/v1/original?x=1");
      assert.deepEqual(request.metadata.headers, [
        { name: "content-type", value: "text/plain;charset=UTF-8" },
        { name: "x-override", value: "yes" },
      ]);
      assert.equal(new TextDecoder().decode(request.body), "replacement");
      return successResponse(successFrame(request));
    },
  });
  const input = new Request(`${origin}/v1/original?x=1`, {
    method: "POST",
    headers: { "x-original": "discarded" },
  });
  const response = await adapter(input, {
    method: "PUT",
    headers: { "x-override": "yes" },
    body: "replacement",
  });
  assert.equal(response.status, 201);
});

test("exact-origin and controlled-header violations fail before transport", async () => {
  let calls = 0;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch() {
      calls += 1;
      throw new Error("transport must not run");
    },
  });
  await assert.rejects(
    adapter("https://example.com/v1/query", { method: "POST" }),
    /origin does not match/,
  );
  await assert.rejects(
    adapter(`${origin}/v1/query#fragment`, { method: "POST" }),
    /must not contain a fragment/,
  );
  await assert.rejects(
    adapter(`${origin}/v1/query`, {
      method: "POST",
      headers: { "accept-encoding": "gzip" },
    }),
    TianaFetchProtocolError,
  );
  await assert.rejects(
    adapter(`${origin}/v1/%00`, { method: "POST" }),
    TianaFetchProtocolError,
  );
  await assert.rejects(
    adapter(`${origin}/v1/query`, { method: "PROPFIND" }),
    /does not support this request method/,
  );
  assert.equal(calls, 0);
});

test("the outer Tiana Token cannot enter TFQ1 metadata", async () => {
  let calls = 0;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch() {
      calls += 1;
      throw new Error("transport must not run");
    },
  });
  const cases = [
    {
      input: `${origin}/v1/query`,
      init: {
        method: "POST",
        headers: { authorization: `Bearer ${tianaToken}` },
      },
    },
    {
      input: `${origin}/v1/query`,
      init: {
        method: "POST",
        headers: { "x-debug-value": `prefix ${tianaToken} suffix` },
      },
    },
    {
      input: `${origin}/v1/query`,
      init: {
        method: "POST",
        headers: { [tianaToken]: "inner-header-name" },
      },
    },
    {
      input: `${origin}/v1/query?credential=${tianaToken}`,
      init: { method: "POST" },
    },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      adapter(fixture.input, fixture.init),
      (error) => {
        assert.ok(error instanceof TianaFetchProtocolError);
        assert.match(error.message, /must not appear in inner Fetch metadata/);
        assert.equal(error.message.includes(tianaToken), false);
        return true;
      },
    );
  }
  assert.equal(calls, 0);
});

test("preflight failures cancel pending request bodies without leaking the Token", async () => {
  let calls = 0;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch() {
      calls += 1;
      throw new Error("transport must not run");
    },
  });
  const cases = [
    {
      input: `${origin}/v1/query`,
      headers: { authorization: `Bearer ${tianaToken}` },
    },
    {
      input: `${origin}/v1/query?credential=${tianaToken}`,
      headers: {},
    },
    {
      input: `${origin}/v1/query`,
      headers: { "accept-encoding": "gzip" },
    },
    {
      input: `${origin}/v1/query`,
      headers: { [tianaToken]: "inner-header-name" },
    },
  ];

  for (const fixture of cases) {
    let cancelled = false;
    const body = new ReadableStream({
      pull() {},
      cancel(reason) {
        cancelled = true;
        assert.equal(String(reason).includes(tianaToken), false);
      },
    });
    await assert.rejects(
      adapter(fixture.input, {
        method: "POST",
        headers: fixture.headers,
        body,
        duplex: "half",
      }),
      (error) => {
        assert.equal(String(error).includes(tianaToken), false);
        return true;
      },
    );
    assert.equal(cancelled, true);
  }
  assert.equal(calls, 0);
});

test("transport rejection cancels an unconsumed inner request body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("pending"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const transportError = new Error("transport unavailable");
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch() {
      throw transportError;
    },
  });
  await assert.rejects(
    adapter(`${origin}/v1/query`, {
      method: "POST",
      body,
      duplex: "half",
    }),
    transportError,
  );
  assert.equal(cancelled, true);
});

test("invalid outer envelope headers cancel the unread response body", async () => {
  const cases = [
    {
      headers: {
        "cache-control": "public",
        "content-type": "application/vnd.tiana.fetch.v1",
      },
      message: /Cache-Control/,
    },
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/vnd.tiana.fetch.v1; charset=utf-8",
      },
      message: /Content-Type/,
    },
    {
      headers: {
        "cache-control": "no-store",
        "content-encoding": "gzip",
        "content-type": "application/vnd.tiana.fetch.v1",
      },
      message: /Content-Encoding/,
    },
  ];

  for (const fixture of cases) {
    let cancelled = false;
    const adapter = createTianaFetch({
      origin,
      tianaToken,
      async fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: fixture.headers },
        );
      },
    });
    await assert.rejects(
      adapter(`${origin}/v1/query`, { method: "POST" }),
      fixture.message,
    );
    assert.equal(cancelled, true);
  }
});

test("invalid configured origins and tokens fail closed", () => {
  assert.throws(
    () => createTianaFetch({ origin: "https://127.0.0.1", tianaToken }),
    /canonical v1 Endpoint authority/,
  );
  assert.throws(
    () => createTianaFetch({ origin: "https://example.com", tianaToken }),
    /canonical v1 Endpoint authority/,
  );
  assert.throws(
    () =>
      createTianaFetch({
        origin:
          "https://ep-81j5c9m7q2v8x4k6n3r0t1w2yz.db.service.internal.tiana.com",
        tianaToken,
      }),
    /canonical v1 Endpoint authority/,
  );
  assert.throws(
    () => createTianaFetch({ origin: `${origin}:8443`, tianaToken }),
    /absolute HTTPS origin/,
  );
  assert.throws(
    () => createTianaFetch({ origin: "http://example.com", tianaToken }),
    /absolute HTTPS origin/,
  );
  assert.throws(
    () => createTianaFetch({ origin, tianaToken: "tia_secret" }),
    /token grammar/,
  );
  assert.doesNotThrow(() =>
    createTianaFetch({ origin: origin.toUpperCase(), tianaToken }),
  );
});

test("canonical outer error is returned once and is never retried", async () => {
  const fixture = await readFile(
    `${fixtureRoot}fetch/error-unavailable.json`,
    "utf8",
  );
  const body = fixture.endsWith("\n") ? fixture.slice(0, -1) : fixture;
  let calls = 0;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch() {
      calls += 1;
      return new Response(body, {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    },
  });
  const response = await adapter(`${origin}/v1/query`, { method: "POST" });
  assert.equal(calls, 1);
  assert.equal(response.status, 503);
  assert.equal(response.url, `${origin}/v1/query`);
  assert.equal(await response.text(), body);
});

test("405 outer errors require the exact Allow: POST contract", async () => {
  const fixture = await readFile(
    `${fixtureRoot}fetch/error-method-not-allowed.json`,
    "utf8",
  );
  const body = fixture.endsWith("\n") ? fixture.slice(0, -1) : fixture;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch() {
      return new Response(body, {
        status: 405,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    },
  });
  await assert.rejects(
    adapter(`${origin}/v1/query`, { method: "POST" }),
    /Allow: POST/,
  );
});

test("post-commit truncated TFS1 errors the Response body without retry", async () => {
  let calls = 0;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      calls += 1;
      const request = decodeRequestFrameBytes(await requestBytes(init));
      const full = successFrame(request);
      return successResponse(full.subarray(0, full.byteLength - 2));
    },
  });
  const response = await adapter(`${origin}/v1/query`, { method: "POST" });
  await assert.rejects(response.arrayBuffer(), TianaFetchProtocolError);
  assert.equal(calls, 1);
});

test("response request_id mismatch fails before exposing a Response and cancels", async () => {
  let cancelled = false;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      const request = decodeRequestFrameBytes(await requestBytes(init));
      const frame = successFrame(request, { request_id: "req-mismatch" });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/vnd.tiana.fetch.v1",
          },
        },
      );
    },
  });
  await assert.rejects(
    adapter(`${origin}/v1/query`, { method: "POST" }),
    /request_id does not match/,
  );
  assert.equal(cancelled, true);
});

test("HEAD request returns a bodyless inner Response", async () => {
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      const request = decodeRequestFrameBytes(await requestBytes(init));
      assert.equal(request.metadata.method, "HEAD");
      assert.equal(request.metadata.body_length, 0);
      const frame = encodeResponseFrameBytes({
        metadata_version: 1,
        request_id: request.metadata.request_id,
        status: 200,
        status_text: "OK",
        headers: [{ name: "content-type", value: "application/json" }],
        body_length: 0,
      });
      return successResponse(frame);
    },
  });
  const response = await adapter(`${origin}/v1/query`, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(await response.text(), "");
});

test("unknown-length request and response bodies enforce the 16 MiB ceiling", async () => {
  let requestCalls = 0;
  const oversizedRequest = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      requestCalls += 1;
      await requestBytes(init);
      throw new Error("oversized request unexpectedly reached a response");
    },
  });
  let requestPhase = 0;
  const requestBody = new ReadableStream({
    pull(controller) {
      if (requestPhase === 0) {
        requestPhase += 1;
        controller.enqueue(new Uint8Array(maxBodyBytes));
      } else if (requestPhase === 1) {
        requestPhase += 1;
        controller.enqueue(new Uint8Array([1]));
      } else {
        controller.close();
      }
    },
  });
  await assert.rejects(
    oversizedRequest(`${origin}/v1/query`, {
      method: "POST",
      body: requestBody,
      duplex: "half",
    }),
    /exceeds the v1 limit/,
  );
  assert.equal(requestCalls, 1);

  let responseCancelled = false;
  const oversizedResponse = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      const request = decodeRequestFrameBytes(await requestBytes(init));
      const head = encodeResponseFrameBytes({
        metadata_version: 1,
        request_id: request.metadata.request_id,
        status: 200,
        status_text: "OK",
        headers: [],
        body_length: null,
      });
      let phase = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (phase === 0) {
              phase += 1;
              controller.enqueue(head);
            } else if (phase === 1) {
              phase += 1;
              controller.enqueue(new Uint8Array(maxBodyBytes));
            } else if (phase === 2) {
              phase += 1;
              controller.enqueue(new Uint8Array([1]));
            }
          },
          cancel() {
            responseCancelled = true;
          },
        }),
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/vnd.tiana.fetch.v1",
          },
        },
      );
    },
  });
  const response = await oversizedResponse(`${origin}/v1/query`, {
    method: "POST",
  });
  await assert.rejects(response.arrayBuffer(), /exceeds the v1 limit/);
  assert.equal(responseCancelled, true);
});

test("cancelling the inner Response body cancels the outer stream", async () => {
  let cancelled = false;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      const request = decodeRequestFrameBytes(await requestBytes(init));
      const frame = successFrame(request, { body_length: null });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(frame);
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/vnd.tiana.fetch.v1",
          },
        },
      );
    },
  });
  const response = await adapter(`${origin}/v1/query`, { method: "POST" });
  await response.body.cancel("caller stopped reading");
  assert.equal(cancelled, true);
});

test("cancelling during a pending outer read converges without stream races", async () => {
  let cancelled = false;
  let pendingReadStarted;
  const pendingRead = new Promise((resolve) => {
    pendingReadStarted = resolve;
  });
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      const request = decodeRequestFrameBytes(await requestBytes(init));
      const head = encodeResponseFrameBytes({
        metadata_version: 1,
        request_id: request.metadata.request_id,
        status: 200,
        status_text: "OK",
        headers: [],
        body_length: null,
      });
      let phase = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (phase === 0) {
              phase += 1;
              controller.enqueue(head);
              return;
            }
            pendingReadStarted();
            return new Promise(() => undefined);
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/vnd.tiana.fetch.v1",
          },
        },
      );
    },
  });
  const response = await adapter(`${origin}/v1/query`, { method: "POST" });
  const reader = response.body.getReader();
  const reading = reader.read();
  await pendingRead;
  await reader.cancel("caller stopped reading");
  assert.deepEqual(await reading, { value: undefined, done: true });
  assert.equal(cancelled, true);
});

test("AbortSignal propagates to the sole outer request", async () => {
  let calls = 0;
  let bodyCancelled = false;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    fetch(_input, init) {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        );
      });
    },
  });
  const controller = new AbortController();
  const body = new ReadableStream({
    pull(streamController) {
      streamController.enqueue(new TextEncoder().encode("pending"));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const result = adapter(`${origin}/v1/query`, {
    method: "POST",
    body,
    duplex: "half",
    signal: controller.signal,
  });
  controller.abort(new DOMException("stopped", "AbortError"));
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(bodyCancelled, true);
});

test("a pre-aborted request never reaches the outer transport", async () => {
  let calls = 0;
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch() {
      calls += 1;
      throw new Error("transport must not run");
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    adapter(`${origin}/v1/query`, {
      method: "POST",
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});

test("abort safely interrupts a pending request-body read", async () => {
  let bodyCancelled = false;
  let transportStarted;
  const started = new Promise((resolve) => {
    transportStarted = resolve;
  });
  const body = new ReadableStream({
    pull() {
      return new Promise(() => undefined);
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const adapter = createTianaFetch({
    origin,
    tianaToken,
    async fetch(_input, init) {
      transportStarted();
      await new Response(init.body).arrayBuffer();
      throw new Error("aborted request body unexpectedly completed");
    },
  });
  const controller = new AbortController();
  const result = adapter(`${origin}/v1/query`, {
    method: "POST",
    body,
    duplex: "half",
    signal: controller.signal,
  });
  await started;
  controller.abort(new DOMException("stopped", "AbortError"));
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(bodyCancelled, true);
});
