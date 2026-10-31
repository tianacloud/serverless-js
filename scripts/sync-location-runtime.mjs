// Explicit integration step; normal SDK build/test never reads another checkout.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const source = await readFile(
  new URL("../dist/location.js", import.meta.url),
  "utf8",
);
if (/^import /m.test(source))
  throw Error("location.js must remain independently embeddable");
const begin = "// BEGIN GENERATED SERVERLESS LOCATION",
  end = "// END GENERATED SERVERLESS LOCATION";
const implementation = source
  .replace(/^export /gm, "")
  .replace(/^\/\/# sourceMappingURL=.*$/gm, "");
const block =
  begin +
  "\nconst createPlatformLocation = (() => {\n" +
  implementation +
  "\nreturn createTianaLocation;\n})();\n" +
  end +
  "\n";
for (const target of process.argv.slice(2)) {
  let text = await readFile(target, "utf8");
  const start = text.indexOf(begin),
    finish = text.indexOf(end);
  if (start >= 0) {
    if (finish < start) throw Error("Incomplete generated region");
    text =
      text.slice(0, start) + text.slice(finish + end.length).replace(/^\n/, "");
  }
  await writeFile(target, block + text);
  const sdk = join(dirname(target), "sdk");
  await mkdir(sdk, { recursive: true });
  for (const name of ["location.js", "jweixin.js"])
    await copyFile(
      new URL("../dist/" + name, import.meta.url),
      join(sdk, name),
    );
  await writeFile(
    join(sdk, "LOCATION_SOURCE.json"),
    JSON.stringify(
      {
        package: "@tianacloud/serverless",
        candidate: true,
        base_commit: execFileSync(
          "git",
          [
            "-C",
            fileURLToPath(new URL("..", import.meta.url)),
            "rev-parse",
            "HEAD",
          ],
          { encoding: "utf8" },
        ).trim(),
        wechat_delivery_sha256: createHash("sha256")
          .update(
            await readFile(new URL("../dist/jweixin.js", import.meta.url)),
          )
          .digest("hex"),
        location_sha256: createHash("sha256").update(source).digest("hex"),
        note: "Local integration candidate. Immutable SDK release provenance is required before publication.",
      },
      null,
      2,
    ) + "\n",
  );
}
