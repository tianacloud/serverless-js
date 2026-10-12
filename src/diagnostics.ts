export interface TianaDiagnostic {
  readonly requestId: string;
  readonly phase:
    | "request_started"
    | "response_started"
    | "completed"
    | "failed"
    | "cancelled";
  readonly time: string;
  readonly outerStatus?: number;
  readonly innerStatus?: number;
  readonly reason?: string;
}

export const diagnostics = new WeakMap<object, TianaDiagnostic>();

/** Return the latest diagnostic state for a Request, Response, or error object. */
export function diagnosisOf(value: unknown): TianaDiagnostic | undefined {
  return typeof value === "object" && value !== null
    ? diagnostics.get(value)
    : undefined;
}

export function createRequestId(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined) {
    throw new TypeError("Web Crypto is required to create a Fetch request ID");
  }
  if (typeof crypto.randomUUID === "function") {
    return `req-${crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    `req-${hex.slice(0, 4).join("")}`,
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}
