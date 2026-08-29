import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testsRoot = fileURLToPath(new URL("./", import.meta.url));
const fixtureRoot = `${testsRoot}fixtures/`;
const expectedTag = "v0.17.2-rc.1";
const expectedCommit = "d252fd7bf689657e50b6caf36298f8c57860df6b";
const expectedSchemaBlob = "cc069b9fc3ea5f9c7f4c0b994cc65641eb8dde78";
const expectedAuthorityBlob = "2af84c65259141a7cd76a82ee848b9a6318cf096";
const expectedTreeHash =
  "0e49b8e80130f6ed47a12222803b4019a6904dc9cc610033bbd01cf0a7875637";

function digest(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

function gitBlobId(bytes) {
  const prefix = Buffer.from(`blob ${bytes.byteLength}\0`);
  return digest("sha1", Buffer.concat([prefix, bytes]));
}

test("vendored fixture bytes exactly match the immutable Contracts tree", async () => {
  const manifest = await readFile(`${fixtureRoot}fetch/MANIFEST.txt`, "utf8");
  assert.match(manifest, new RegExp(`^source_tag=${expectedTag}$`, "m"));
  assert.match(manifest, new RegExp(`^source_commit=${expectedCommit}$`, "m"));
  assert.match(
    manifest,
    new RegExp(`^source_fixture_tree_sha256=${expectedTreeHash}$`, "m"),
  );

  const tree = await readFile(`${testsRoot}contracts/fetch-fixture-tree.txt`);
  assert.equal(digest("sha256", tree), expectedTreeHash);
  const entries = tree
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(line);
      assert.ok(match, line);
      return { blob: match[1], path: match[2] };
    });
  assert.equal(entries.length, 70);

  for (const entry of entries) {
    const relative = entry.path.replace(/^fixtures\//, "");
    const bytes = await readFile(`${fixtureRoot}${relative}`);
    assert.equal(gitBlobId(bytes), entry.blob, entry.path);
  }

  const positive = await readdir(`${fixtureRoot}fetch`);
  const negative = await readdir(`${fixtureRoot}negative/fetch`);
  assert.equal(positive.length, 20); // 19 released files plus MANIFEST.txt.
  assert.equal(negative.length, 51);
});

test("vendored schema is the exact immutable Contracts release blob", async () => {
  const schema = await readFile(`${testsRoot}contracts/fetch-v1.schema.json`);
  assert.equal(gitBlobId(schema), expectedSchemaBlob);
});

test("public Endpoint authority is pinned to the immutable v1 fixture", async () => {
  const authority = await readFile(
    `${fixtureRoot}gateway/public-connect-authority-v1.json`,
  );
  assert.equal(gitBlobId(authority), expectedAuthorityBlob);
  assert.deepEqual(JSON.parse(authority.toString("utf8")), {
    authority_version: 1,
    endpoint_suffix: ".db.service.internal.tiana.com",
    default_port: 443,
  });
});
