import { protocolError } from "./errors.js";

export const FETCH_PROTOCOL_VERSION = 1;
export const FETCH_PATH = "/v1/fetch";
export const FETCH_MEDIA_TYPE = "application/vnd.tiana.fetch.v1";
export const FETCH_ERROR_MEDIA_TYPE = "application/json";
export const FETCH_REQUEST_MAGIC = "TFQ1";
export const FETCH_RESPONSE_MAGIC = "TFS1";
export const FETCH_FRAME_PREFIX_BYTES = 10;
export const FETCH_MAX_METADATA_BYTES = 64 << 10;
export const FETCH_MAX_HEADERS = 128;
export const FETCH_MAX_HEADER_NAME_BYTES = 256;
export const FETCH_MAX_HEADER_VALUE_BYTES = 16 << 10;
export const FETCH_MAX_PATH_QUERY_BYTES = 16 << 10;
export const FETCH_MAX_REQUEST_BODY_BYTES = 16 << 20;
export const FETCH_MAX_RESPONSE_BODY_BYTES = 16 << 20;
export const FETCH_MAX_STATUS_TEXT_BYTES = 128;
export const FETCH_MAX_RETRY_AFTER_MS = 60_000;
export const FETCH_MAX_ERROR_BODY_BYTES = 64 << 10;

export type FetchMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";

export interface FetchHeader {
  readonly name: string;
  readonly value: string;
}

export interface FetchRequestMetadata {
  readonly metadata_version: 1;
  readonly request_id: string;
  readonly protocol?: "tiana-http";
  readonly method: FetchMethod;
  readonly path_query: string;
  readonly headers: readonly FetchHeader[];
  readonly body_length: number | null;
}

export interface FetchResponseMetadata {
  readonly metadata_version: 1;
  readonly request_id: string;
  readonly status: number;
  readonly status_text: string;
  readonly headers: readonly FetchHeader[];
  readonly body_length: number | null;
}

const ERROR_DEFINITIONS = {
  ACTIVATION_RESOURCE_PRESSURE: { status: 503, message: "activation resource pressure", retryable: true, retryAfter: "optional" },
  ACTIVATION_NO_IDLE_POD: { status: 503, message: "activation has no idle pod", retryable: true, retryAfter: "optional" },
  ACTIVATION_CAPACITY_UNAVAILABLE: { status: 503, message: "activation capacity unavailable", retryable: true, retryAfter: "optional" },

  FETCH_INVALID_ARGUMENT: {
    status: 400,
    message: "invalid fetch request",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_AUTH_REQUIRED: {
    status: 401,
    message: "authentication required",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_ACCESS_DENIED: {
    status: 403,
    message: "access denied",
    retryable: false,
    retryAfter: "forbidden",
  },
  QUOTA_EXCEEDED: {
    status: 403,
    message: "tenant quota exceeded",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_ENDPOINT_NOT_FOUND: {
    status: 404,
    message: "endpoint not found",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_METHOD_NOT_ALLOWED: {
    status: 405,
    message: "method not allowed",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_REQUEST_TIMEOUT: {
    status: 408,
    message: "fetch request timeout",
    retryable: true,
    retryAfter: "optional",
  },
  FETCH_PAYLOAD_TOO_LARGE: {
    status: 413,
    message: "fetch payload too large",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "unsupported fetch media type",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_RATE_LIMITED: {
    status: 429,
    message: "fetch rate limit exceeded",
    retryable: true,
    retryAfter: "required",
  },
  FETCH_INTERNAL: {
    status: 500,
    message: "fetch gateway error",
    retryable: false,
    retryAfter: "forbidden",
  },
  FETCH_BAD_GATEWAY: {
    status: 502,
    message: "fetch backend failure",
    retryable: true,
    retryAfter: "optional",
  },
  FETCH_UNAVAILABLE: {
    status: 503,
    message: "fetch temporarily unavailable",
    retryable: true,
    retryAfter: "optional",
  },
  FETCH_TIMEOUT: {
    status: 504,
    message: "fetch gateway timeout",
    retryable: true,
    retryAfter: "optional",
  },
} as const;

export type FetchErrorCode = keyof typeof ERROR_DEFINITIONS;
export type FetchQuotaReason = "compute" | "storage" | "compute_and_storage";

export interface FetchError {
  readonly code: FetchErrorCode;
  readonly message: string;
  readonly reason?: FetchQuotaReason;
  readonly retryable: boolean;
  readonly request_not_executed: true;
  readonly retry_after_ms?: number;
}

export interface FetchErrorResponse {
  readonly error: FetchError;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const methodSet = new Set<FetchMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const quotaReasonSet = new Set<FetchQuotaReason>([
  "compute",
  "storage",
  "compute_and_storage",
]);

const forbiddenHeaders = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "expect",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < required.length ||
    keys.length > required.length + optional.length
  ) {
    throw protocolError("Fetch JSON fields do not match the v1 contract");
  }
}

function isTokenByte(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    "!#$%&'*+-.^_`|~".includes(String.fromCharCode(code))
  );
}

function isForbiddenHeader(name: string): boolean {
  return (
    forbiddenHeaders.has(name) ||
    name.startsWith("proxy-") ||
    name.startsWith("tiana-") ||
    name.startsWith("x-forwarded-")
  );
}

function validateHeader(header: FetchHeader, request: boolean): void {
  if (
    header.name.length === 0 ||
    header.name.length > FETCH_MAX_HEADER_NAME_BYTES
  ) {
    throw protocolError("Fetch header name is invalid");
  }
  for (let index = 0; index < header.name.length; index += 1) {
    const code = header.name.charCodeAt(index);
    if (code >= 0x41 && code <= 0x5a) {
      throw protocolError("Fetch header name is invalid");
    }
    if (!isTokenByte(code)) {
      throw protocolError("Fetch header name is invalid");
    }
  }
  if (isForbiddenHeader(header.name) && !(header.name === "content-length" && !request && /^(0|[1-9][0-9]*)$/.test(header.value) && Number(header.value) <= FETCH_MAX_RESPONSE_BODY_BYTES)) {
    throw protocolError("Fetch header is controlled by the Gateway");
  }
  if (header.value.length > FETCH_MAX_HEADER_VALUE_BYTES) {
    throw protocolError("Fetch header value is invalid");
  }
  if (
    header.value.startsWith(" ") ||
    header.value.startsWith("\t") ||
    header.value.endsWith(" ") ||
    header.value.endsWith("\t")
  ) {
    throw protocolError("Fetch header value is invalid");
  }
  for (let index = 0; index < header.value.length; index += 1) {
    const code = header.value.charCodeAt(index);
    if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
      throw protocolError("Fetch header value is invalid");
    }
  }
}

function validateHeaders(headers: readonly FetchHeader[], request: boolean): void {
  if (headers.length > FETCH_MAX_HEADERS) {
    throw protocolError("Fetch headers exceed the v1 limit");
  }
  const singletons = new Set<string>();
  for (const header of headers) {
    validateHeader(header, request);
    if (
      (request && (header.name === "authorization" || header.name === "content-type")) || (!request && (header.name === "content-length" || header.name === "content-encoding"))
    ) {
      if (singletons.has(header.name)) {
        throw protocolError("Fetch request singleton header is duplicated");
      }
      singletons.add(header.name);
    }
  }
}

function validatePathQuery(value: string): void {
  if (
    value.length === 0 ||
    value.length > FETCH_MAX_PATH_QUERY_BYTES ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    throw protocolError("Fetch path_query is not a bounded origin-form path");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x23 || code === 0x5c) {
      throw protocolError("Fetch path_query contains an invalid byte");
    }
    if (code === 0x25) {
      if (index + 2 >= value.length) {
        throw protocolError("Fetch path_query has an invalid percent escape");
      }
      const encoded = value.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(encoded)) {
        throw protocolError("Fetch path_query has an invalid percent escape");
      }
      const decoded = Number.parseInt(encoded, 16);
      if (
        decoded < 0x21 ||
        decoded === 0x7f ||
        decoded === 0x23 ||
        decoded === 0x5c
      ) {
        throw protocolError("Fetch path_query percent escape is unsafe");
      }
      index += 2;
    }
  }
}

function validateBodyLength(value: number | null, maximum: number): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value < 0 || value > maximum)
  ) {
    throw protocolError("Fetch body_length is invalid");
  }
}

export function validateRequestMetadata(metadata: FetchRequestMetadata): void {
  if (metadata.metadata_version !== FETCH_PROTOCOL_VERSION) {
    throw protocolError("Fetch metadata_version is invalid");
  }
  if (!requestIdPattern.test(metadata.request_id)) {
    throw protocolError("Fetch request_id is invalid");
  }
  if (metadata.protocol !== undefined && metadata.protocol !== "tiana-http") {
    throw protocolError("Fetch protocol is invalid");
  }
  if (!methodSet.has(metadata.method)) {
    throw protocolError("Fetch method is invalid");
  }
  validatePathQuery(metadata.path_query);
  if (!Array.isArray(metadata.headers)) {
    throw protocolError("Fetch headers must be an array");
  }
  validateHeaders(metadata.headers, true);
  validateBodyLength(metadata.body_length, FETCH_MAX_REQUEST_BODY_BYTES);
  if (
    (metadata.method === "GET" || metadata.method === "HEAD") &&
    metadata.body_length !== 0
  ) {
    throw protocolError("GET and HEAD Fetch requests require body_length 0");
  }
}

export function validateResponseMetadata(metadata: FetchResponseMetadata): void {
  if (metadata.metadata_version !== FETCH_PROTOCOL_VERSION) {
    throw protocolError("Fetch metadata_version is invalid");
  }
  if (!requestIdPattern.test(metadata.request_id)) {
    throw protocolError("Fetch request_id is invalid");
  }
  if (!Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599) {
    throw protocolError("Fetch response status is invalid");
  }
  if (metadata.status_text.length > FETCH_MAX_STATUS_TEXT_BYTES) {
    throw protocolError("Fetch response status_text is invalid");
  }
  for (let index = 0; index < metadata.status_text.length; index += 1) {
    const code = metadata.status_text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      throw protocolError("Fetch response status_text is invalid");
    }
  }
  if (!Array.isArray(metadata.headers)) {
    throw protocolError("Fetch headers must be an array");
  }
  validateHeaders(metadata.headers, false);
  validateBodyLength(metadata.body_length, FETCH_MAX_RESPONSE_BODY_BYTES);
  if (
    (metadata.status === 204 || metadata.status === 205 || metadata.status === 304) &&
    metadata.body_length !== 0
  ) {
    throw protocolError("Bodyless Fetch response requires body_length 0");
  }
}

function canonicalRequestObject(metadata: FetchRequestMetadata): FetchRequestMetadata {
  return {
    metadata_version: 1,
    request_id: metadata.request_id,
    ...(metadata.protocol === undefined ? {} : { protocol: metadata.protocol }),
    method: metadata.method,
    path_query: metadata.path_query,
    headers: metadata.headers.map(({ name, value }) => ({ name, value })),
    body_length: metadata.body_length,
  };
}

function canonicalResponseObject(metadata: FetchResponseMetadata): FetchResponseMetadata {
  return {
    metadata_version: 1,
    request_id: metadata.request_id,
    status: metadata.status,
    status_text: metadata.status_text,
    headers: metadata.headers.map(({ name, value }) => ({ name, value })),
    body_length: metadata.body_length,
  };
}

function encodeCanonical(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw protocolError("Fetch metadata cannot be encoded");
  }
  return encoder.encode(json);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function parseCanonicalJson(bytes: Uint8Array): unknown {
  let json: string;
  try {
    json = decoder.decode(bytes);
  } catch {
    throw protocolError("Fetch metadata is not valid UTF-8");
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw protocolError("Fetch metadata is not valid JSON");
  }
}

function decodeHeaders(value: unknown): FetchHeader[] {
  if (!Array.isArray(value)) {
    throw protocolError("Fetch headers must be an array");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw protocolError("Fetch header must be an object");
    }
    assertExactKeys(item, ["name", "value"]);
    if (typeof item.name !== "string" || typeof item.value !== "string") {
      throw protocolError("Fetch header fields must be strings");
    }
    return { name: item.name, value: item.value };
  });
}

export function encodeRequestMetadata(metadata: FetchRequestMetadata): Uint8Array {
  validateRequestMetadata(metadata);
  const bytes = encodeCanonical(canonicalRequestObject(metadata));
  if (bytes.byteLength > FETCH_MAX_METADATA_BYTES) {
    throw protocolError("Fetch metadata exceeds the v1 limit");
  }
  return bytes;
}

export function decodeRequestMetadata(bytes: Uint8Array): FetchRequestMetadata {
  if (bytes.byteLength > FETCH_MAX_METADATA_BYTES) {
    throw protocolError("Fetch metadata exceeds the v1 limit");
  }
  const parsed = parseCanonicalJson(bytes);
  if (!isRecord(parsed)) {
    throw protocolError("Fetch request metadata must be an object");
  }
  assertExactKeys(parsed, [
    "metadata_version",
    "request_id",
    ...("protocol" in parsed ? ["protocol"] : []),
    "method",
    "path_query",
    "headers",
    "body_length",
  ]);
  if (
    parsed.metadata_version !== 1 ||
    typeof parsed.request_id !== "string" ||
    ("protocol" in parsed && parsed.protocol !== "tiana-http") ||
    typeof parsed.method !== "string" ||
    !methodSet.has(parsed.method as FetchMethod) ||
    typeof parsed.path_query !== "string" ||
    (parsed.body_length !== null && typeof parsed.body_length !== "number")
  ) {
    throw protocolError("Fetch request metadata fields are invalid");
  }
  const metadata: FetchRequestMetadata = {
    metadata_version: 1,
    request_id: parsed.request_id,
    ...(parsed.protocol === "tiana-http" ? { protocol: parsed.protocol } : {}),
    method: parsed.method as FetchMethod,
    path_query: parsed.path_query,
    headers: decodeHeaders(parsed.headers),
    body_length: parsed.body_length,
  };
  validateRequestMetadata(metadata);
  if (!bytesEqual(bytes, encodeCanonical(canonicalRequestObject(metadata)))) {
    throw protocolError("Fetch request metadata is not canonical JSON");
  }
  return metadata;
}

export function encodeResponseMetadata(metadata: FetchResponseMetadata): Uint8Array {
  validateResponseMetadata(metadata);
  const bytes = encodeCanonical(canonicalResponseObject(metadata));
  if (bytes.byteLength > FETCH_MAX_METADATA_BYTES) {
    throw protocolError("Fetch metadata exceeds the v1 limit");
  }
  return bytes;
}

export function decodeResponseMetadata(bytes: Uint8Array): FetchResponseMetadata {
  if (bytes.byteLength > FETCH_MAX_METADATA_BYTES) {
    throw protocolError("Fetch metadata exceeds the v1 limit");
  }
  const parsed = parseCanonicalJson(bytes);
  if (!isRecord(parsed)) {
    throw protocolError("Fetch response metadata must be an object");
  }
  assertExactKeys(parsed, [
    "metadata_version",
    "request_id",
    "status",
    "status_text",
    "headers",
    "body_length",
  ]);
  if (
    parsed.metadata_version !== 1 ||
    typeof parsed.request_id !== "string" ||
    typeof parsed.status !== "number" ||
    typeof parsed.status_text !== "string" ||
    (parsed.body_length !== null && typeof parsed.body_length !== "number")
  ) {
    throw protocolError("Fetch response metadata fields are invalid");
  }
  const metadata: FetchResponseMetadata = {
    metadata_version: 1,
    request_id: parsed.request_id,
    status: parsed.status,
    status_text: parsed.status_text,
    headers: decodeHeaders(parsed.headers),
    body_length: parsed.body_length,
  };
  validateResponseMetadata(metadata);
  if (!bytesEqual(bytes, encodeCanonical(canonicalResponseObject(metadata)))) {
    throw protocolError("Fetch response metadata is not canonical JSON");
  }
  return metadata;
}

function canonicalErrorObject(error: FetchError): FetchErrorResponse {
  const canonical: {
    error: {
      code: FetchErrorCode;
      message: string;
      reason?: FetchQuotaReason;
      retryable: boolean;
      request_not_executed: true;
      retry_after_ms?: number;
    };
  } = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      retryable: error.retryable,
      request_not_executed: true,
    },
  };
  if (error.retry_after_ms !== undefined) {
    canonical.error.retry_after_ms = error.retry_after_ms;
  }
  return canonical;
}

export function decodeErrorResponse(
  bytes: Uint8Array,
  outerStatus: number,
): FetchErrorResponse {
  if (bytes.byteLength > FETCH_MAX_ERROR_BODY_BYTES) {
    throw protocolError("Fetch error body exceeds the SDK bound");
  }
  const parsed = parseCanonicalJson(bytes);
  if (!isRecord(parsed)) {
    throw protocolError("Fetch error response must be an object");
  }
  assertExactKeys(parsed, ["error"]);
  if (!isRecord(parsed.error)) {
    throw protocolError("Fetch error must be an object");
  }
  assertExactKeys(
    parsed.error,
    ["code", "message", "retryable", "request_not_executed"],
    ["reason", "retry_after_ms"],
  );
  if (
    typeof parsed.error.code !== "string" ||
    !Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, parsed.error.code) ||
    typeof parsed.error.message !== "string" ||
    typeof parsed.error.retryable !== "boolean" ||
    parsed.error.request_not_executed !== true
  ) {
    throw protocolError("Fetch error fields are invalid");
  }
  const code = parsed.error.code as FetchErrorCode;
  const definition = ERROR_DEFINITIONS[code];
  if (
    definition.status !== outerStatus ||
    definition.message !== parsed.error.message ||
    definition.retryable !== parsed.error.retryable
  ) {
    throw protocolError("Fetch error tuple does not match the v1 registry");
  }
  const reason = parsed.error.reason;
  if (code === "QUOTA_EXCEEDED") {
    if (typeof reason !== "string" || !quotaReasonSet.has(reason as FetchQuotaReason)) {
      throw protocolError("Fetch quota reason is invalid");
    }
  } else if (reason !== undefined) {
    throw protocolError("Fetch error reason is only valid for quota errors");
  }
  const retryAfter = parsed.error.retry_after_ms;
  if (retryAfter !== undefined) {
    if (
      typeof retryAfter !== "number" ||
      !Number.isSafeInteger(retryAfter) ||
      retryAfter < 1 ||
      retryAfter > FETCH_MAX_RETRY_AFTER_MS
    ) {
      throw protocolError("Fetch retry_after_ms is invalid");
    }
  }
  if (definition.retryAfter === "required" && retryAfter === undefined) {
    throw protocolError("Fetch error requires retry_after_ms");
  }
  if (definition.retryAfter === "forbidden" && retryAfter !== undefined) {
    throw protocolError("Fetch error forbids retry_after_ms");
  }
  const error: FetchError = retryAfter === undefined
    ? {
        code,
        message: parsed.error.message,
        ...(reason === undefined ? {} : { reason: reason as FetchQuotaReason }),
        retryable: parsed.error.retryable,
        request_not_executed: true,
      }
    : {
        code,
        message: parsed.error.message,
        ...(reason === undefined ? {} : { reason: reason as FetchQuotaReason }),
        retryable: parsed.error.retryable,
        request_not_executed: true,
        retry_after_ms: retryAfter,
      };
  const response = canonicalErrorObject(error);
  if (!bytesEqual(bytes, encodeCanonical(response))) {
    throw protocolError("Fetch error response is not canonical JSON");
  }
  return response;
}

export function isRegisteredOuterStatus(status: number): boolean {
  return Object.values(ERROR_DEFINITIONS).some(
    (definition) => definition.status === status,
  );
}
