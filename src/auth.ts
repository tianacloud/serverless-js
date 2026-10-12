import {
  diagnostics,
  createRequestId,
  type TianaDiagnostic,
} from "./diagnostics.js";

/** Account credentials are held only by the auth provider, never by data frames. */
export interface TianaSessionCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Unix milliseconds. Tokens are opaque; the SDK never decodes their expiry. */
  readonly expiresAt: number;
  readonly refreshExpiresAt: number;
  readonly syncStatus?: "pending" | "complete" | "failed";
}

/** Share one provider across endpoints using the same login session. */
export interface TianaAuthProvider {
  getAccessToken(options?: { readonly signal?: AbortSignal }): Promise<string>;
}

export type TianaAuthErrorCode =
  | "AUTH_LOGIN_REQUIRED"
  | "AUTH_REFRESH_UNCERTAIN"
  | "AUTH_PERSIST_FAILED"
  | "AUTH_NOT_READY";

export class TianaAuthError extends Error {
  readonly code: TianaAuthErrorCode;
  constructor(code: TianaAuthErrorCode) {
    super(
      {
        AUTH_LOGIN_REQUIRED: "Sign in again to obtain account credentials",
        AUTH_REFRESH_UNCERTAIN:
          "Refresh outcome is unknown; obtain new credentials before continuing",
        AUTH_PERSIST_FAILED: "New credentials could not be saved",
        AUTH_NOT_READY: "Account authorization is not ready for data requests",
      }[code],
    );
    this.name = "TianaAuthError";
    this.code = code;
  }
}

export interface TianaSessionAuthOptions {
  readonly managementOrigin: string | URL;
  readonly credentials: TianaSessionCredentials;
  /** Save the entire replacement atomically. Failures never restore old tokens. */
  readonly persist?: (
    credentials: TianaSessionCredentials,
  ) => void | Promise<void>;
  /** Independent management transport; never the Tiana data adapter itself. */
  readonly fetch?: typeof globalThis.fetch;
  readonly refreshBeforeMs?: number;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Management request diagnostics; callback failures do not affect auth. */
  readonly onDiagnostic?: (diagnostic: TianaDiagnostic) => void;
}

const maxResponseBytes = 64 * 1024;
function originOf(value: string | URL): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("managementOrigin must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("managementOrigin must be an HTTPS origin");
  }
  return url.origin;
}
function secret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16384 &&
    !/[\s\x00-\x1f\x7f]/u.test(value)
  );
}
function timestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 8640000000000000
  );
}
function copyCredentials(
  value: TianaSessionCredentials,
): TianaSessionCredentials {
  if (
    !value ||
    !secret(value.accessToken) ||
    !secret(value.refreshToken) ||
    !timestamp(value.expiresAt) ||
    !timestamp(value.refreshExpiresAt) ||
    (value.syncStatus !== undefined &&
      !["pending", "complete", "failed"].includes(value.syncStatus))
  ) {
    throw new TypeError("Invalid session credentials");
  }
  return Object.freeze({
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    refreshExpiresAt: value.refreshExpiresAt,
    ...(value.syncStatus === undefined ? {} : { syncStatus: value.syncStatus }),
  });
}
function positive(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new TypeError(`Invalid ${name}`);
  return value;
}
function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}
/** Cancelling a waiter never cancels a shared refresh or credential save. */
export function waitFor<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
async function readJSON(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Missing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await waitFor(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) throw new Error("Response limit");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid response");
    return result as Record<string, unknown>;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Lazy, single-flight account rotation. Data requests are never retried here. */
export function createTianaSessionAuth(
  options: TianaSessionAuthOptions,
): TianaAuthProvider {
  const origin = originOf(options.managementOrigin);
  let credentials = copyCredentials(options.credentials);
  const transport = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof transport !== "function") throw new TypeError("Fetch is required");
  if (options.persist !== undefined && typeof options.persist !== "function")
    throw new TypeError("Invalid persist callback");
  const refreshBeforeMs = positive(
    options.refreshBeforeMs ?? 30000,
    3600000,
    "refreshBeforeMs",
  );
  const timeoutMs = positive(options.timeoutMs ?? 15000, 300000, "timeoutMs");
  const pollIntervalMs = positive(
    options.pollIntervalMs ?? 250,
    10000,
    "pollIntervalMs",
  );
  let ready = credentials.syncStatus === "complete";
  let savePending = false;
  const save = options.persist;
  let saving: Promise<void> | undefined;
  let stopped: TianaAuthError | undefined;
  let work: Promise<void> | undefined;
  let currentDiagnostic: TianaDiagnostic | undefined;
  let diagnosticPending = false;
  function emitDiagnostic(
    phase: TianaDiagnostic["phase"],
    fields: Pick<TianaDiagnostic, "outerStatus" | "reason"> = {},
  ): void {
    if (!currentDiagnostic) return;
    currentDiagnostic = {
      ...currentDiagnostic,
      phase,
      time: new Date().toISOString(),
      ...fields,
    };
    try {
      options.onDiagnostic?.(currentDiagnostic);
    } catch {
      /* Observation does not change authentication. */
    }
  }
  function beginRequest(): string {
    const requestId = createRequestId();
    currentDiagnostic = {
      requestId,
      phase: "request_started",
      time: new Date().toISOString(),
    };
    diagnosticPending = true;
    emitDiagnostic("request_started");
    return requestId;
  }
  function completeRequest(): void {
    emitDiagnostic("completed");
    diagnosticPending = false;
  }

  async function run(): Promise<void> {
    if (stopped) throw stopped;
    // Saving a successful rotation takes precedence over any later rotation.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;
    try {
      if (savePending) await persist(signal);
      if (credentials.expiresAt <= Date.now() + refreshBeforeMs) {
        if (credentials.refreshExpiresAt <= Date.now()) {
          stopped = new TianaAuthError("AUTH_LOGIN_REQUIRED");
          throw stopped;
        }
        const startedAt = Date.now();
        const requestId = beginRequest();
        let response: Response;
        let body: Record<string, unknown>;
        try {
          response = await waitFor(
            transport(`${origin}/api/v1/auth/refresh`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-request-id": requestId,
                "cache-control": "no-store",
              },
              body: JSON.stringify({ refresh_token: credentials.refreshToken }),
              signal,
              credentials: "omit",
              cache: "no-store",
              redirect: "error",
            }),
            signal,
          );
          emitDiagnostic("response_started", { outerStatus: response.status });
          if (response.status === 400) {
            const failure = await readJSON(response, signal);
            if (
              failure.error === "invalid_grant" ||
              failure.error === "expired" ||
              failure.error === "denied"
            ) {
              stopped = new TianaAuthError("AUTH_LOGIN_REQUIRED");
              throw stopped;
            }
            throw new Error("Unknown rotation outcome");
          }
          if (response.status === 401 || response.status === 403) {
            void response.body?.cancel().catch(() => undefined);
            stopped = new TianaAuthError("AUTH_LOGIN_REQUIRED");
            throw stopped;
          }
          if (response.status !== 200 || response.redirected) {
            void response.body?.cancel().catch(() => undefined);
            throw new Error("Unknown rotation outcome");
          }
          body = await readJSON(response, signal);
          if (
            body.token_type !== "Bearer" ||
            !Number.isSafeInteger(body.expires_in) ||
            (body.expires_in as number) <= 0 ||
            typeof body.refresh_expires_at !== "string" ||
            !["pending", "complete", "failed"].includes(
              body.sync_status as string,
            )
          )
            throw new Error("Invalid rotation response");
          credentials = copyCredentials({
            accessToken: body.access_token as string,
            refreshToken: body.refresh_token as string,
            expiresAt: startedAt + (body.expires_in as number) * 1000,
            refreshExpiresAt: Date.parse(body.refresh_expires_at),
            syncStatus: body.sync_status as "pending" | "complete" | "failed",
          });
        } catch {
          stopped ??= new TianaAuthError("AUTH_REFRESH_UNCERTAIN");
          throw stopped;
        }
        completeRequest();
        ready = credentials.syncStatus === "complete";
        savePending = true;
        await persist(signal);
      }
      let pollDelay = pollIntervalMs;
      while (!ready) {
        const requestId = beginRequest();
        const response = await waitFor(
          transport(`${origin}/api/v1/auth/transactions/whoami`, {
            headers: {
              authorization: `Bearer ${credentials.accessToken}`,
              "x-request-id": requestId,
              "cache-control": "no-store",
            },
            signal,
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
          }),
          signal,
        );
        emitDiagnostic("response_started", { outerStatus: response.status });
        if (response.status !== 200 || response.redirected) {
          void response.body?.cancel().catch(() => undefined);
          throw new TianaAuthError("AUTH_NOT_READY");
        }
        const body = await readJSON(response, signal);
        if (body.sync_status === "complete") {
          completeRequest();
          ready = true;
          break;
        }
        if (body.sync_status !== "pending")
          throw new TianaAuthError("AUTH_NOT_READY");
        completeRequest();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(poll);
            signal.removeEventListener("abort", onAbort);
            reject(new TianaAuthError("AUTH_NOT_READY"));
          };
          const poll = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, pollDelay);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
        pollDelay = Math.min(pollDelay * 2, Math.max(pollIntervalMs, 2000));
      }
      if (credentials.expiresAt <= Date.now())
        throw new TianaAuthError("AUTH_NOT_READY");
    } catch (error) {
      const reported =
        error instanceof TianaAuthError
          ? error
          : new TianaAuthError("AUTH_NOT_READY");
      const phase = signal.aborted ? "cancelled" : "failed";
      if (diagnosticPending) {
        emitDiagnostic(phase, { reason: reported.name });
        diagnosticPending = false;
      }
      if (currentDiagnostic)
        diagnostics.set(reported, {
          ...currentDiagnostic,
          phase,
          reason: reported.name,
        });
      throw reported;
    } finally {
      clearTimeout(timer);
    }
  }
  async function persist(signal: AbortSignal): Promise<void> {
    if (!saving) {
      const snapshot = copyCredentials(credentials);
      const started = Promise.resolve()
        .then(() => save?.(snapshot))
        .then(() => {
          savePending = false;
        });
      saving = started;
      void started.then(
        () => {
          saving = undefined;
        },
        () => {
          saving = undefined;
        },
      );
    }
    // A timed out save may still finish. Join it on the next call rather than
    // starting a second save or rotating credentials while it is unresolved.
    try {
      await waitFor(saving, signal);
    } catch {
      throw new TianaAuthError("AUTH_PERSIST_FAILED");
    }
  }
  return Object.freeze({
    async getAccessToken(input?: {
      readonly signal?: AbortSignal;
    }): Promise<string> {
      if (input?.signal?.aborted) throw abortReason(input.signal);
      if (stopped) throw stopped;
      if (
        !work &&
        !savePending &&
        ready &&
        credentials.expiresAt > Date.now() + refreshBeforeMs
      )
        return credentials.accessToken;
      if (!work) {
        const started = Promise.resolve().then(run);
        work = started;
        void started.then(
          () => {
            work = undefined;
          },
          () => {
            work = undefined;
          },
        );
      }
      try {
        await waitFor(work, input?.signal);
      } catch (error) {
        // A cancelled waiter is distinct from the shared management request.
        if (
          input?.signal?.aborted &&
          currentDiagnostic &&
          typeof error === "object" &&
          error !== null
        ) {
          diagnostics.set(error, {
            ...currentDiagnostic,
            phase: "cancelled",
            reason: "AbortError",
          });
        }
        throw error;
      }
      return credentials.accessToken;
    },
  });
}
