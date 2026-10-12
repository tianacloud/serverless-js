import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("public Endpoint authority remains compatible with Fetch v1", async () => {
  const authority = await readFile(
    new URL("./fixtures/gateway/public-connect-authority-v1.json", import.meta.url),
    "utf8",
  );
  assert.deepEqual(JSON.parse(authority), {
    authority_version: 1,
    endpoint_suffix: ".db.service.internal.tiana.com",
    default_port: 443,
  });
});
