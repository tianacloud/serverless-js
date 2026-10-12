import {
  createTianaFetch,
  diagnosisOf,
  createTianaSessionAuth,
  type TianaAuthProvider,
  type TianaSessionCredentials,
  TianaFetchProtocolError,
  type FetchErrorResponse,
  type FetchQuotaReason,
  type TianaFetch,
  type TianaFetchOptions,
  type TianaDiagnostic,
  type TianaOuterErrorCode,
} from "@tianacloud/serverless";

const options: TianaFetchOptions = {
  origin: new URL(
    "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.example.test",
  ),
  tianaToken: `tia_0${"A".repeat(42)}A`,
  fetch: globalThis.fetch,
  protocol: "tiana-http",
  onDiagnostic(event: TianaDiagnostic) {
    void event.requestId;
  },
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
const quotaReason: FetchQuotaReason = "compute";
const quotaBody: FetchErrorResponse = {
  error: {
    code: "QUOTA_EXCEEDED",
    message: "tenant quota exceeded",
    reason: quotaReason,
    retryable: false,
    request_not_executed: true,
  },
};

void response;
void body;
void quotaBody;
void protocolError;
void diagnosisOf(new Error("example"));

const credentials: TianaSessionCredentials = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3600000,
  refreshExpiresAt: Date.now() + 86400000,
};
const auth: TianaAuthProvider = createTianaSessionAuth({
  managementOrigin: "https://console.example.test",
  credentials,
  onDiagnostic: (diagnostic: TianaDiagnostic) => { void diagnostic.requestId; },
  persist: async (next) => {
    void next;
  },
});
createTianaFetch({ origin: options.origin, auth });
// @ts-expect-error Credential sources are mutually exclusive.
createTianaFetch({ origin: options.origin, auth, tianaToken: "static" });
// @ts-expect-error An adapter must have a credential source.
createTianaFetch({ origin: options.origin });
