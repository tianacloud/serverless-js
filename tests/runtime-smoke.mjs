import {
  createTianaFetch,
  TianaFetchProtocolError,
} from "@tianacloud/serverless";
import {
  decodeRequestFrameBytes,
  encodeResponseFrameBytes,
} from "../dist/codec.js";

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const origin =
  "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.db.service.internal.tiana.com";
const adapter = createTianaFetch({
  origin,
  tianaToken: `tia_0${"A".repeat(42)}A`,
  async fetch(_input, init) {
    const frame = new Uint8Array(await new Response(init.body).arrayBuffer());
    const request = decodeRequestFrameBytes(frame);
    const body = new TextEncoder().encode("edge-ok");
    const response = encodeResponseFrameBytes(
      {
        metadata_version: 1,
        request_id: request.metadata.request_id,
        status: 200,
        status_text: "OK",
        headers: [{ name: "content-type", value: "text/plain" }],
        body_length: body.byteLength,
      },
      body,
    );
    return new Response(response, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/vnd.tiana.fetch.v1",
      },
    });
  },
});

const response = await adapter(`${origin}/v1/query`, { method: "POST" });
check(response instanceof Response, "adapter did not return a platform Response");
check(
  typeof TianaFetchProtocolError === "function",
  "public package export is missing",
);
check(response.status === 200, "inner status mismatch");
check(response.url === `${origin}/v1/query`, "inner response URL mismatch");
check((await response.text()) === "edge-ok", "inner body mismatch");
console.log("TIANA_SERVERLESS_RUNTIME_SMOKE_PASS");
