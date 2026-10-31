import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("installed tarball exposes buffered codecs through the public subpath", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tiana-codec-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", directory,
  ], { cwd: root, encoding: "utf8" }));
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    join(directory, packed[0].filename),
  ], { cwd: directory, encoding: "utf8" });
  const metadata = JSON.parse(await readFile(new URL("./fixtures/fetch/response-200-metadata.json", import.meta.url), "utf8"));
  const golden = (await readFile(new URL("./fixtures/fetch/response-200-golden.hex", import.meta.url), "utf8")).trim();
  await writeFile(join(directory, "consumer.mjs"), `
    import assert from "node:assert/strict";
    import * as codec from "@tianacloud/serverless/codec";
    import { TianaFetchProtocolError } from "@tianacloud/serverless";
    assert.deepEqual(Object.keys(codec).sort(), [
      "decodeRequestFrameBytes", "decodeResponseFrameBytes",
      "encodeRequestFrameBytes", "encodeResponseFrameBytes",
    ]);
    const metadata = ${JSON.stringify(metadata)};
    const golden = Buffer.from(${JSON.stringify(golden)}, "hex");
    const body = new TextEncoder().encode('{"ok":1}');
    assert.deepEqual(Buffer.from(codec.encodeResponseFrameBytes(metadata, body)), golden);
    const decoded = codec.decodeResponseFrameBytes(new Uint8Array(golden), { requestId: metadata.request_id, method: "POST" });
    assert.deepEqual(decoded.metadata, metadata);
    assert.deepEqual(decoded.body, body);
    assert.throws(() => codec.decodeResponseFrameBytes(new Uint8Array()), TianaFetchProtocolError);
  `);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, encoding: "utf8" });
});
