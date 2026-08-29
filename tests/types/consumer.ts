import {
  createTianaFetch,
  TianaFetchProtocolError,
  type FetchErrorResponse,
  type TianaFetch,
  type TianaFetchOptions,
  type TianaOuterErrorCode,
} from "@tiana/serverless";

const options: TianaFetchOptions = {
  origin: new URL(
    "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.db.service.internal.tiana.com",
  ),
  tianaToken: `tia_${"A".repeat(42)}A`,
  fetch: globalThis.fetch,
};

const tianaFetch: TianaFetch = createTianaFetch(options);
const controller = new AbortController();
const response: Promise<Response> = tianaFetch(
  new Request(`${options.origin}/v1/query`, {
    method: "POST",
    signal: controller.signal,
  }),
);
const code: TianaOuterErrorCode = "FETCH_UNAVAILABLE";
const body: FetchErrorResponse = {
  error: {
    code,
    message: "fetch temporarily unavailable",
    retryable: true,
    request_not_executed: true,
  },
};
const protocolError: Error = new TianaFetchProtocolError("invalid frame");

void response;
void body;
void protocolError;
