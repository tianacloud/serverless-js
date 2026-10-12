import { diagnostics, createRequestId, type TianaDiagnostic } from "./diagnostics.js";
export { diagnosisOf, type TianaDiagnostic } from "./diagnostics.js";
import { waitFor, TianaAuthError, type TianaAuthProvider } from "./auth.js";
export { createTianaSessionAuth, TianaAuthError } from "./auth.js";
export type {
  TianaAuthProvider,
  TianaSessionAuthOptions,
  TianaSessionCredentials,
  TianaAuthErrorCode,
} from "./auth.js";
import {
  createRequestFrameStream,
  encodeRequestFrameBytes,
  decodeResponseStream,
} from "./codec.js";
import { protocolError } from "./errors.js";
import {
  decodeErrorResponse,
  FETCH_ERROR_MEDIA_TYPE,
  FETCH_MAX_ERROR_BODY_BYTES,
  FETCH_MEDIA_TYPE,
  FETCH_PATH,
  FETCH_MAX_REQUEST_BODY_BYTES,
  isRegisteredOuterStatus,
  type FetchError,
  type FetchErrorCode,
  type FetchErrorResponse,
  type FetchHeader,
  type FetchMethod,
  type FetchRequestMetadata,
} from "./protocol.js";

export { TianaFetchProtocolError } from "./errors.js";
export type {
  FetchError,
  FetchErrorCode,
  FetchErrorResponse,
  FetchHeader,
  FetchQuotaReason,
} from "./protocol.js";

export type TianaFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface TianaFetchBaseOptions {
  /** The sole HTTPS database origin accepted by this adapter. */
  readonly origin: string | URL;

  /** Select the App HTTP data socket. Omit for the native data socket. */
  readonly protocol?: "tiana-http";

  /** Buffer the request frame for browser transports without upload streaming. */
  readonly requestBodyMode?: "stream" | "buffered";

  /** Optional platform-compatible transport. It is invoked exactly once. */
  readonly fetch?: typeof globalThis.fetch;

  /** Per-request diagnostic events; callback failures do not affect Fetch. */
  readonly onDiagnostic?: (diagnostic: TianaDiagnostic) => void;
}

/** Exactly one credential source; the provider is shared across requests. */
export type TianaFetchOptions = TianaFetchBaseOptions &
  (
    | { readonly tianaToken: string; readonly auth?: never }
    | { readonly auth: TianaAuthProvider; readonly tianaToken?: never }
  );

const endpointHostnamePattern =
  /^ep-[0-7][0-9a-hjkmnp-tv-z]{25}\.[a-z0-9.-]+$/;
const allowedMethods = new Set<FetchMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

function normalizeOrigin(value: string | URL): string {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    throw new TypeError("Tiana origin must be an absolute HTTPS origin URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Tiana origin must be an absolute HTTPS origin URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (!endpointHostnamePattern.test(hostname)) {
    throw new TypeError("Tiana origin must contain a valid v1 Endpoint ID and DNS suffix");
  }
  return url.origin;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function normalizedHeaders(request: Request): FetchHeader[] {
  return Array.from(request.headers.entries(), ([name, value]) => ({
    name,
    value,
  }));
}

function decodePercentEscapedBytes(value: string): string {
  return value.replace(
    /%([0-9a-f]{2})/gi,
    (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function requestMetadata(
  request: Request,
  tianaToken: string,
  requestId: string,
): FetchRequestMetadata {
  const url = new URL(request.url);
  if (!allowedMethods.has(request.method as FetchMethod)) {
    throw new TypeError("Tiana Fetch does not support this request method");
  }
  const method = request.method as FetchMethod;
  const pathQuery = `${url.pathname}${url.search}`;
  const headers = normalizedHeaders(request);
  const normalizedToken = tianaToken.toLowerCase();
  if (
    pathQuery.includes(tianaToken) ||
    decodePercentEscapedBytes(pathQuery).includes(tianaToken) ||
    headers.some(
      ({ name, value }) =>
        name.includes(normalizedToken) || value.includes(tianaToken),
    )
  ) {
    throw protocolError(
      "The outer Tiana Token must not appear in inner Fetch metadata",
    );
  }
  return {
    metadata_version: 1,
    request_id: requestId,
    method,
    path_query: pathQuery,
    headers,
    body_length:
      method === "GET" || method === "HEAD" || request.body === null ? 0 : null,
  };
}

async function requireOuterHeaders(
  response: Response,
  contentType: string,
): Promise<void> {
  try {
    if (response.headers.get("cache-control") !== "no-store") {
      throw protocolError("Fetch outer response is missing Cache-Control: no-store");
    }
    if (response.headers.get("content-type") !== contentType) {
      throw protocolError("Fetch outer response has an invalid Content-Type");
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding !== null && contentEncoding !== "identity") {
      throw protocolError("Fetch outer response has an invalid Content-Encoding");
    }
    if (response.redirected) {
      throw protocolError("Fetch outer response must not follow redirects");
    }
  } catch (error) {
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array> {
  if (body === null) {
    throw protocolError("Fetch outer response body is missing");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (result.value.byteLength === 0) {
        continue;
      }
      length += result.value.byteLength;
      if (length > maximum) {
        throw protocolError("Fetch outer response body exceeds the SDK bound");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readRequestBody(request: Request): Promise<Uint8Array> {
  if (request.signal.aborted) throw abortReason(request.signal);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(request.signal));
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const body = new Uint8Array(await Promise.race([request.arrayBuffer(), aborted]));
    if (request.signal.aborted) throw abortReason(request.signal);
    if (body.byteLength > FETCH_MAX_REQUEST_BODY_BYTES) throw protocolError("Fetch body exceeds the SDK bound");
    return body;
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
}

function responseWithUrl(response: Response, url: string): Response {
  try {
    Object.defineProperty(response, "url", {
      configurable: true,
      enumerable: false,
      value: url,
    });
  } catch {
    // URL is supplemental metadata. Fetch body/status/header semantics remain
    // correct on runtimes that do not permit defining an own URL property.
  }
  return response;
}

async function outerErrorResponse(
  outer: Response,
  requestUrl: string,
): Promise<Response> {
  if (!isRegisteredOuterStatus(outer.status)) {
    await outer.body?.cancel().catch(() => undefined);
    throw protocolError("Fetch outer response status is not registered");
  }
  await requireOuterHeaders(outer, FETCH_ERROR_MEDIA_TYPE);
  if (outer.status === 405 && outer.headers.get("allow") !== "POST") {
    await outer.body?.cancel().catch(() => undefined);
    throw protocolError("Fetch 405 response is missing Allow: POST");
  }
  const body = await readBoundedBody(outer.body, FETCH_MAX_ERROR_BODY_BYTES);
  decodeErrorResponse(body, outer.status);
  return responseWithUrl(
    new Response(new Uint8Array(body), {
      status: outer.status,
      statusText: outer.statusText,
      headers: new Headers(outer.headers),
    }),
    requestUrl,
  );
}

function innerHeaders(headers: readonly FetchHeader[]): Headers {
  const result = new Headers();
  for (const { name, value } of headers) {
    result.append(name, value);
  }
  return result;
}

async function innerResponse(
  outer: Response,
  request: Request,
  metadata: FetchRequestMetadata,
  onBodyComplete: () => void,
  onBodyError: (error: unknown) => void,
  onBodyCancel: (reason: unknown) => void,
): Promise<Response> {
  await requireOuterHeaders(outer, FETCH_MEDIA_TYPE);
  if (outer.body === null) {
    throw protocolError("Fetch TFS1 response body is missing");
  }
  const decoded = await decodeResponseStream(outer.body, {
    requestId: metadata.request_id,
    method: metadata.method,
    onBodyComplete,
    onBodyError,
    onBodyCancel,
  });
  return responseWithUrl(
    new Response(decoded.body, {
      status: decoded.metadata.status,
      statusText: decoded.metadata.status_text,
      headers: innerHeaders(decoded.metadata.headers),
    }),
    request.url,
  );
}

/**
 * Create a standard Fetch-compatible adapter for one exact Tiana database
 * origin. The returned function performs exactly one outer request and never
 * retries automatically.
 */
export function createTianaFetch(options: TianaFetchOptions): TianaFetch {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Tiana Fetch options are required");
  }
  if (options.protocol !== undefined && options.protocol !== "tiana-http") {
    throw new TypeError("Unsupported Tiana Fetch protocol");
  }
  const protocol = options.protocol;
  const requestBodyMode = options.requestBodyMode ?? "stream";
  if (requestBodyMode !== "stream" && requestBodyMode !== "buffered") {
    throw new TypeError("requestBodyMode must be either stream or buffered");
  }
  const origin = normalizeOrigin(options.origin);
  const provider = options.auth;
  const staticToken = options.tianaToken;
  if (
    provider !== undefined
      ? staticToken !== undefined ||
        typeof provider?.getAccessToken !== "function"
      : typeof staticToken !== "string" || staticToken.length === 0
  ) {
    throw new TypeError("Exactly one of tianaToken or auth is required");
  }
  const fetchImplementation =
    options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImplementation !== "function") {
    throw new TypeError(
      "A standards-compatible Fetch implementation is required",
    );
  }
  const gatewayUrl = `${origin}${FETCH_PATH}`;

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const requestId = createRequestId();
    let response: Response | undefined;
    let last: TianaDiagnostic;
    const emit = (
      phase: TianaDiagnostic["phase"],
      fields: Pick<TianaDiagnostic, "outerStatus" | "innerStatus" | "reason"> = {},
    ): void => {
      last = {
        requestId,
        phase,
        time: new Date().toISOString(),
        ...(last?.outerStatus !== undefined ? { outerStatus: last.outerStatus } : {}),
        ...(last?.innerStatus !== undefined ? { innerStatus: last.innerStatus } : {}),
        ...fields,
      };
      diagnostics.set(request, last);
      if (input instanceof Request) diagnostics.set(input, last);
      if (response !== undefined) diagnostics.set(response, last);
      try {
        options.onDiagnostic?.(last);
      } catch {
        // Observation must not change the request outcome.
      }
    };
    const fail = (error: unknown): void => {
      const cancelled = request.signal.aborted;
      emit(cancelled ? "cancelled" : "failed", {
        reason: error instanceof Error ? error.name : typeof error,
      });
      if (typeof error === "object" && error !== null &&
          !(error instanceof TianaAuthError && diagnostics.has(error))) {
        diagnostics.set(error, last);
      }
    };
    emit("request_started");
    let metadata: FetchRequestMetadata;
    let tianaToken: string;
    let frame: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>;
    try {
      const url = new URL(request.url);
      if (url.origin !== origin) {
        throw new TypeError(
          "Tiana Fetch request origin does not match the configured origin",
        );
      }
      if (url.hash !== "") {
        throw new TypeError(
          "Tiana Fetch request URL must not contain a fragment",
        );
      }
      if (request.signal.aborted) {
        throw abortReason(request.signal);
      }
      // Buffer before acquiring auth so upload preparation cannot age a token.
      const body =
        protocol === "tiana-http" || requestBodyMode === "buffered"
          ? await readRequestBody(request)
          : undefined;
      tianaToken = provider
        ? await waitFor(
            Promise.resolve().then(() =>
              provider.getAccessToken({ signal: request.signal }),
            ),
            request.signal,
          )
        : staticToken!;
      if (request.signal.aborted) throw abortReason(request.signal);
      if (
        typeof tianaToken !== "string" ||
        tianaToken.length === 0 ||
        /[\s\x00-\x1f\x7f]/u.test(tianaToken)
      )
        throw new TypeError("Invalid access token");
      metadata = requestMetadata(request, tianaToken, requestId);
      if (body !== undefined) {
        metadata = {
          ...metadata,
          ...(protocol ? { protocol } : {}),
          body_length: body.byteLength,
        };
        frame = new Uint8Array(encodeRequestFrameBytes(metadata, body));
      } else {
        frame = createRequestFrameStream(
          metadata,
          request.body,
          request.signal,
        );
      }
    } catch (error) {
      await request.body?.cancel(error).catch(() => undefined);
      fail(error);
      throw error;
    }
    const headers = new Headers();
    headers.set("authorization", `Bearer ${tianaToken}`);
    headers.set("cache-control", "no-store");
    headers.set("content-type", FETCH_MEDIA_TYPE);
    headers.set("x-request-id", requestId);
    const outerInit: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers,
      body: frame,
      signal: request.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...(frame instanceof ReadableStream ? { duplex: "half" as const } : {}),
    };
    let outer: Response;
    try {
      outer = await fetchImplementation(gatewayUrl, outerInit);
    } catch (error) {
      if (frame instanceof ReadableStream) {
        await frame.cancel(error).catch(() => undefined);
      }
      fail(error);
      throw error;
    }
    try {
      if (outer.status !== 200) {
        response = await outerErrorResponse(outer, request.url);
        emit("response_started", { outerStatus: outer.status });
        emit("completed");
        return response;
      }
      response = await innerResponse(
        outer,
        request,
        metadata,
        () => emit("completed"),
        (error) => fail(error),
        (reason) => {
          emit("cancelled", { reason: reason instanceof Error ? reason.name : typeof reason });
        },
      );
      emit("response_started", { outerStatus: outer.status, innerStatus: response.status });
      if (response.body === null) emit("completed");
      return response;
    } catch (error) {
      fail(error);
      throw error;
    }
  };
}

// Keep these names reachable to API extractors without exposing codec internals.
export type TianaOuterError = FetchError;
export type TianaOuterErrorCode = FetchErrorCode;
export type TianaOuterErrorResponse = FetchErrorResponse;

export { createTianaFiles, TianaFileError } from "./files.js";
export type {
  TianaFiles, TianaFilesOptions, TianaFile, TianaFilePage, TianaFileCapabilities,
  TianaFileGrant, TianaFileUpload, TianaFileRequest, TianaFileRequestOptions,
  TianaFilePutOptions,
} from "./files.js";
