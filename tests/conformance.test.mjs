import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeRequestFrameBytes,
  decodeResponseFrameBytes,
  encodeRequestFrameBytes,
  encodeResponseFrameBytes,
} from "@tianacloud/serverless/codec";
import { TianaFetchProtocolError } from "../dist/errors.js";
import {
  decodeErrorResponse,
  decodeRequestMetadata,
  decodeResponseMetadata,
  encodeRequestMetadata,
  encodeResponseMetadata,
  FETCH_MAX_HEADERS,
  FETCH_MAX_HEADER_NAME_BYTES,
  FETCH_MAX_HEADER_VALUE_BYTES,
  FETCH_MAX_PATH_QUERY_BYTES,
  FETCH_MAX_REQUEST_BODY_BYTES,
  FETCH_MAX_RESPONSE_BODY_BYTES,
  FETCH_MAX_RETRY_AFTER_MS,
} from "../dist/protocol.js";

const testsRoot = fileURLToPath(new URL("./", import.meta.url));
const fixtureRoot = `${testsRoot}fixtures/`;

async function text(path) {
  return readFile(`${fixtureRoot}${path}`, "utf8");
}

async function hex(path) {
  const value = (await text(path)).trim();
  assert.match(value, /^(?:[0-9a-f]{2})+$/);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

async function httpJson(path) {
  const value = await text(path);
  return new TextEncoder().encode(value.endsWith("\n") ? value.slice(0, -1) : value);
}

const errorStatus = {
  FETCH_INVALID_ARGUMENT: 400,
  FETCH_AUTH_REQUIRED: 401,
  FETCH_ACCESS_DENIED: 403,
  FETCH_ENDPOINT_NOT_FOUND: 404,
  FETCH_METHOD_NOT_ALLOWED: 405,
  FETCH_REQUEST_TIMEOUT: 408,
  FETCH_PAYLOAD_TOO_LARGE: 413,
  FETCH_UNSUPPORTED_MEDIA_TYPE: 415,
  FETCH_RATE_LIMITED: 429,
  FETCH_INTERNAL: 500,
  FETCH_BAD_GATEWAY: 502,
  FETCH_UNAVAILABLE: 503,
  FETCH_TIMEOUT: 504,
};

test("released TFQ1 request golden is byte-exact", async () => {
  const metadata = JSON.parse(await text("fetch/request-post-metadata.json"));
  const expected = await hex("fetch/request-post-golden.hex");
  const body = new TextEncoder().encode('{"q":1}');
  assert.deepEqual(encodeRequestFrameBytes(metadata, body), expected);
  const decoded = decodeRequestFrameBytes(expected);
  assert.deepEqual(decoded.metadata, metadata);
  assert.deepEqual(decoded.body, body);
});

test("released TFS1 response golden is byte-exact", async () => {
  const metadata = JSON.parse(await text("fetch/response-200-metadata.json"));
  const expected = await hex("fetch/response-200-golden.hex");
  const body = new TextEncoder().encode('{"ok":1}');
  assert.deepEqual(encodeResponseFrameBytes(metadata, body), expected);
  const decoded = decodeResponseFrameBytes(expected, {
    requestId: "req-fetch-0001",
    method: "POST",
  });
  assert.deepEqual(decoded.metadata, metadata);
  assert.deepEqual(decoded.body, body);
});

test("TypeScript null-length metadata matches released canonical bytes", async () => {
  const requestText = (await text("fetch/request-ts-null-metadata.json")).trim();
  const responseText = (await text("fetch/response-ts-null-metadata.json")).trim();
  const requestBytes = new TextEncoder().encode(requestText);
  const responseBytes = new TextEncoder().encode(responseText);
  assert.deepEqual(
    encodeRequestMetadata(JSON.parse(requestText)),
    requestBytes,
  );
  assert.deepEqual(
    encodeResponseMetadata(JSON.parse(responseText)),
    responseBytes,
  );
  assert.deepEqual(decodeRequestMetadata(requestBytes), JSON.parse(requestText));
  assert.deepEqual(decodeResponseMetadata(responseBytes), JSON.parse(responseText));
});

test("Fetch v1 hard limits remain compatible", () => {
  assert.equal(FETCH_MAX_HEADERS, 128);
  assert.equal(FETCH_MAX_HEADER_NAME_BYTES, 256);
  assert.equal(FETCH_MAX_HEADER_VALUE_BYTES, 16_384);
  assert.equal(FETCH_MAX_PATH_QUERY_BYTES, 16_384);
  assert.equal(FETCH_MAX_REQUEST_BODY_BYTES, 16_777_216);
  assert.equal(FETCH_MAX_RESPONSE_BODY_BYTES, 16_777_216);
  assert.equal(FETCH_MAX_RETRY_AFTER_MS, 60_000);
});

test("all released canonical outer errors decode with their exact status", async () => {
  const names = (await readdir(`${fixtureRoot}fetch`))
    .filter((name) => name.startsWith("error-") && name.endsWith(".json"))
    .sort();
  assert.equal(names.length, 13);
  for (const name of names) {
    const bytes = await httpJson(`fetch/${name}`);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    const status = errorStatus[parsed.error.code];
    assert.ok(status, name);
    assert.deepEqual(decodeErrorResponse(bytes, status), parsed, name);
  }
});

test("quota errors preserve their registered reason without relaxing JSON fields", () => {
  for (const reason of ["compute", "storage", "compute_and_storage"]) {
    const parsed = {
      error: {
        code: "QUOTA_EXCEEDED",
        message: "tenant quota exceeded",
        reason,
        retryable: false,
        request_not_executed: true,
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(parsed));
    assert.deepEqual(decodeErrorResponse(bytes, 403), parsed);
  }

  for (const error of [
    {
      code: "QUOTA_EXCEEDED",
      message: "tenant quota exceeded",
      retryable: false,
      request_not_executed: true,
    },
    {
      code: "QUOTA_EXCEEDED",
      message: "tenant quota exceeded",
      reason: "unknown",
      retryable: false,
      request_not_executed: true,
    },
    {
      code: "FETCH_ACCESS_DENIED",
      message: "access denied",
      reason: "compute",
      retryable: false,
      request_not_executed: true,
    },
    {
      code: "QUOTA_EXCEEDED",
      message: "tenant quota exceeded",
      reason: "compute",
      retryable: false,
      request_not_executed: true,
      extra: true,
    },
  ]) {
    const bytes = new TextEncoder().encode(JSON.stringify({ error }));
    assert.throws(
      () => decodeErrorResponse(bytes, 403),
      TianaFetchProtocolError,
    );
  }
});

test("historical negatives fail closed except newly supported encoding headers", async () => {
  const names = (await readdir(`${fixtureRoot}negative/fetch`)).sort();
  assert.equal(names.length, 51);
  for (const name of names) {
    const operation = async () => {
      if (name.endsWith(".json")) {
        const bytes = await httpJson(`negative/fetch/${name}`);
        let status = 400;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(bytes));
          status = errorStatus[parsed?.error?.code] ?? status;
        } catch {
          // The strict decoder below remains the authority.
        }
        decodeErrorResponse(bytes, status);
        return;
      }
      const bytes = await hex(`negative/fetch/${name}`);
      if (name.startsWith("response-")) {
        decodeResponseFrameBytes(
          bytes,
          name.startsWith("response-head-") ? { method: "HEAD" } : {},
        );
      } else {
        decodeRequestFrameBytes(bytes);
      }
    };
    if (name === "request-accept-encoding.hex") {
      await operation(); // Historical vector: inner Accept-Encoding is now supported.
    } else {
      await assert.rejects(operation, TianaFetchProtocolError, name);
    }
  }
});
