import {
  createRequestFrameStream,
  decodeResponseStream,
} from "./codec.js";
import { protocolError } from "./errors.js";
import {
  decodeErrorResponse,
  FETCH_ERROR_MEDIA_TYPE,
  FETCH_MAX_ERROR_BODY_BYTES,
  FETCH_MEDIA_TYPE,
  FETCH_PATH,
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
} from "./protocol.js";

export type TianaFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface TianaFetchOptions {
  /** The sole HTTPS database origin accepted by this adapter. */
  readonly origin: string | URL;

  /** Raw outer Tiana Token. It is never copied into TFQ1 metadata. */
  readonly tianaToken: string;

  /** Optional platform-compatible transport. It is invoked exactly once. */
  readonly fetch?: typeof globalThis.fetch;
}

const tianaTokenPattern = /^tia_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const endpointHostnamePattern =
  /^ep-[0-7][0-9a-hjkmnp-tv-z]{25}\.db\.service\.internal\.tiana\.com$/;
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
    url.hash !== "" ||
    url.port !== ""
  ) {
    throw new TypeError("Tiana origin must be an absolute HTTPS origin URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (!endpointHostnamePattern.test(hostname)) {
    throw new TypeError("Tiana origin must be a canonical v1 Endpoint authority");
  }
  return url.origin;
}

function createRequestId(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined) {
    throw new TypeError("Web Crypto is required to create a Fetch request ID");
  }
  if (typeof crypto.randomUUID === "function") {
    return `req-${crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    `req-${hex.slice(0, 4).join("")}`,
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
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

function requestMetadata(
  request: Request,
  tianaToken: string,
): FetchRequestMetadata {
  const url = new URL(request.url);
  if (!allowedMethods.has(request.method as FetchMethod)) {
    throw new TypeError("Tiana Fetch does not support this request method");
  }
  const method = request.method as FetchMethod;
  const pathQuery = `${url.pathname}${url.search}`;
  const headers = normalizedHeaders(request);
  if (
    pathQuery.includes(tianaToken) ||
    headers.some(({ value }) => value.includes(tianaToken))
  ) {
    throw protocolError(
      "The outer Tiana Token must not appear in inner Fetch metadata",
    );
  }
  return {
    metadata_version: 1,
    request_id: createRequestId(),
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
): Promise<Response> {
  await requireOuterHeaders(outer, FETCH_MEDIA_TYPE);
  if (outer.body === null) {
    throw protocolError("Fetch TFS1 response body is missing");
  }
  const decoded = await decodeResponseStream(outer.body, {
    requestId: metadata.request_id,
    method: metadata.method,
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
  const origin = normalizeOrigin(options.origin);
  if (!tianaTokenPattern.test(options.tianaToken)) {
    throw new TypeError("tianaToken does not match the v1 token grammar");
  }
  const tianaToken = options.tianaToken;
  const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A standards-compatible Fetch implementation is required");
  }
  const gatewayUrl = `${origin}${FETCH_PATH}`;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin) {
      throw new TypeError("Tiana Fetch request origin does not match the configured origin");
    }
    if (url.hash !== "") {
      throw new TypeError("Tiana Fetch request URL must not contain a fragment");
    }
    if (request.signal.aborted) {
      throw abortReason(request.signal);
    }
    const metadata = requestMetadata(request, tianaToken);
    const frame = createRequestFrameStream(metadata, request.body, request.signal);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${tianaToken}`);
    headers.set("cache-control", "no-store");
    headers.set("content-type", FETCH_MEDIA_TYPE);
    const outerInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers,
      body: frame,
      signal: request.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      duplex: "half",
    };
    let outer: Response;
    try {
      outer = await fetchImplementation(gatewayUrl, outerInit);
    } catch (error) {
      await frame.cancel(error).catch(() => undefined);
      throw error;
    }
    if (outer.status !== 200) {
      return outerErrorResponse(outer, request.url);
    }
    return innerResponse(outer, request, metadata);
  };
}

// Keep these names reachable to API extractors without exposing codec internals.
export type TianaOuterError = FetchError;
export type TianaOuterErrorCode = FetchErrorCode;
export type TianaOuterErrorResponse = FetchErrorResponse;
