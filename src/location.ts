/** One-shot device location. This module has no import-time browser side effects. */
export type TianaLocationErrorCode =
  | "PERMISSION_DENIED"
  | "UNAVAILABLE"
  | "TIMEOUT"
  | "ABORTED"
  | "UNSUPPORTED"
  | "CONFIGURATION"
  | "INVALID_RESULT"
  | "BUSY"
  | "DISPOSED";
export interface TianaPosition {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number;
  /** Unix milliseconds; WeChat reports the receipt time, not a sensor timestamp. */
  readonly timestamp: number;
  readonly coordinateSystem: "WGS-84";
}
export interface TianaLocationRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface TianaLocationOptions {
  /** Platform-owned same-origin signing endpoint. AppID is server-owned. */
  readonly signingUrl?: string;
  /** Same-origin, pinned official JS-SDK resource, loaded only on demand. */
  readonly sdkUrl?: string;
  /** Original document URL, captured before SPA navigation. */
  readonly entryUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}
export interface TianaLocation {
  getCurrentPosition(
    options?: TianaLocationRequestOptions,
  ): Promise<TianaPosition>;
  dispose(): void;
}
export class TianaLocationError extends Error {
  constructor(
    readonly code: TianaLocationErrorCode,
    readonly diagnostic?: string,
  ) {
    super(`Device location failed (${code})`);
    this.name = "TianaLocationError";
  }
}
type Callback = (value?: unknown) => void;
interface WechatAPI {
  config(value: object): void;
  ready(callback: Callback): void;
  error(callback: Callback): void;
  getLocation(value: {
    type: "wgs84";
    success: Callback;
    fail: Callback;
    cancel: Callback;
  }): void;
}
type ClientWindow = Window & {
  __tianaLocationCreateWechatSDK?: () => { api: WechatAPI; dispose(): void };
  __wxjs_environment?: unknown;
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function nativeDiagnostic(value: unknown): string {
  const message = record(value).errMsg;
  if (typeof message !== "string") return "WX_CONFIG_REJECTED";
  if (/invalid[\s_-]*signature/i.test(message)) return "WX_SIGNATURE_INVALID";
  if (/invalid[\s_-]*(url|domain)/i.test(message))
    return "WX_DOMAIN_NOT_ALLOWED";
  if (/invalid[\s_-]*app[\s_-]*id/i.test(message)) return "WX_APP_ID_INVALID";
  if (/permission|no[\s_-]*access/i.test(message)) return "WX_API_PERMISSION";
  return "WX_CONFIG_REJECTED";
}
function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.length > 64) return NaN;
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
    ? Number(value)
    : NaN;
}
function position(
  value: unknown,
  wechat: boolean,
  started: number,
): TianaPosition {
  const raw = record(value),
    fields = wechat ? raw : record(raw.coords);
  const latitude = wechat ? numeric(fields.latitude) : fields.latitude;
  const longitude = wechat ? numeric(fields.longitude) : fields.longitude;
  const accuracy = wechat ? numeric(fields.accuracy) : fields.accuracy;
  const timestamp = wechat ? Date.now() : raw.timestamp;
  const invalid = (field: string): never => {
    throw new TianaLocationError(
      "INVALID_RESULT",
      "RESULT_" + field + "_INVALID",
    );
  };
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90
  )
    invalid("LATITUDE");
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  )
    invalid("LONGITUDE");
  if (
    typeof accuracy !== "number" ||
    !Number.isFinite(accuracy) ||
    accuracy < 0
  )
    invalid("ACCURACY");
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    !(timestamp >= started - 1000 && timestamp <= Date.now() + 60000)
  )
    invalid("TIMESTAMP");
  return Object.freeze({
    latitude: latitude as number,
    longitude: longitude as number,
    accuracy: accuracy as number,
    timestamp: timestamp as number,
    coordinateSystem: "WGS-84",
  });
}
function sameOrigin(value: string | undefined, view: ClientWindow): URL {
  if (!value)
    throw new TianaLocationError(
      "CONFIGURATION",
      "WX_CONFIGURATION_UNAVAILABLE",
    );
  const url = new URL(value);
  if (
    url.origin !== view.location.origin ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TianaLocationError("CONFIGURATION", "WX_CONFIGURATION_ORIGIN");
  return url;
}
async function publicConfig(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new TianaLocationError("CONFIGURATION", "WX_SIGN_HTTP_FAILED");
  if (!response.body)
    throw new TianaLocationError("CONFIGURATION", "WX_SIGN_RESPONSE_INVALID");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel().catch(() => undefined);
        throw new TianaLocationError(
          "CONFIGURATION",
          "WX_SIGN_RESPONSE_INVALID",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return record(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
/** Platform factories own configuration; application calls need no environment branches. */
export function createTianaLocation(
  options: TianaLocationOptions = {},
): TianaLocation {
  const view =
    typeof window === "undefined" ||
    !window.document ||
    !window.navigator ||
    !window.location
      ? undefined
      : (window as ClientWindow);
  const entryUrl = (options.entryUrl ?? view?.location.href ?? "").split(
    "#",
  )[0]!;
  const transport = options.fetch ?? globalThis.fetch;
  const ua = view?.navigator.userAgent ?? "";
  const desktop =
    /Windows NT|WindowsWechat|Macintosh|MacWechat|X11/i.test(ua) &&
    !/Android|iPhone|iPad|Mobile/i.test(ua);
  const wechat =
    !!view &&
    !desktop &&
    (/MicroMessenger|miniProgram/i.test(ua) ||
      view.__wxjs_environment === "miniprogram");
  const waiters = new Set<(error: TianaLocationError) => void>();
  let disposed = false,
    configured: WechatAPI | undefined,
    configuredRelease: (() => void) | undefined,
    pending:
      | { promise: Promise<WechatAPI>; abort: AbortController }
      | undefined,
    attempts = 0;
  function prepare(): Promise<WechatAPI> {
    if (configured) return Promise.resolve(configured);
    if (pending) return pending.promise;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopSetup: (() => void) | undefined;
    let releaseSDK: (() => void) | undefined;
    const work = (async () => {
      if (!view) throw new TianaLocationError("UNSUPPORTED");
      const endpoint = sameOrigin(options.signingUrl, view),
        scriptUrl = sameOrigin(options.sdkUrl, view),
        documentUrl = new URL(entryUrl);
      if (
        documentUrl.origin !== view.location.origin ||
        documentUrl.username ||
        documentUrl.password
      )
        throw new TianaLocationError("CONFIGURATION", "WX_ENTRY_URL_INVALID");
      const active = (): void => {
        if (abort.signal.aborted || disposed)
          throw new TianaLocationError("CONFIGURATION", "WX_SETUP_CANCELLED");
      };
      const wx = await new Promise<WechatAPI>((resolve, reject) => {
        const script = view.document.createElement("script");
        const priorFactory = view.__tianaLocationCreateWechatSDK;
        let finished = false;
        if (attempts++) scriptUrl.searchParams.set("retry", String(attempts));
        script.src = scriptUrl.href;
        const finish = (error?: TianaLocationError, api?: WechatAPI): void => {
          if (finished) return;
          finished = true;
          script.onload = null;
          script.onerror = null;
          script.remove();
          abort.signal.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve(api!);
        };
        const cancel = (): void =>
          finish(
            new TianaLocationError("CONFIGURATION", "WX_SDK_LOAD_CANCELLED"),
          );
        abort.signal.addEventListener("abort", cancel, { once: true });
        script.onload = () => {
          if (finished) return;
          try {
            if (view.__tianaLocationCreateWechatSDK === priorFactory)
              throw Error("SDK factory was not refreshed");
            const handle = view.__tianaLocationCreateWechatSDK?.();
            if (!handle || typeof handle.dispose !== "function")
              throw Error("Invalid SDK factory");
            releaseSDK = () => handle.dispose();
            if (
              !handle.api ||
              !["config", "ready", "error", "getLocation"].every(
                (key) =>
                  typeof (handle.api as unknown as Record<string, unknown>)[
                    key
                  ] === "function",
              )
            )
              throw Error("Invalid SDK");
            finish(undefined, handle.api);
          } catch {
            finish(
              new TianaLocationError("CONFIGURATION", "WX_SDK_LOAD_FAILED"),
            );
          }
        };
        script.onerror = () =>
          finish(new TianaLocationError("CONFIGURATION", "WX_SDK_LOAD_FAILED"));
        view.document.head.append(script);
      });
      active();
      endpoint.searchParams.set("url", entryUrl);
      const response = await transport(endpoint.href, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
      });
      active();
      const config = await publicConfig(response);
      active();
      if (
        typeof config.app_id !== "string" ||
        !/^wx[a-f0-9]{16}$/i.test(config.app_id) ||
        config.url !== entryUrl ||
        !Number.isSafeInteger(config.timestamp) ||
        (config.timestamp as number) <= 0 ||
        typeof config.nonce_str !== "string" ||
        config.nonce_str.length < 1 ||
        config.nonce_str.length > 256 ||
        typeof config.signature !== "string" ||
        !/^[a-f0-9]{40}$/i.test(config.signature)
      )
        throw new TianaLocationError(
          "CONFIGURATION",
          "WX_SIGN_RESPONSE_INVALID",
        );
      return await new Promise<WechatAPI>((resolve, reject) => {
        wx.ready(() => {
          if (!abort.signal.aborted && !disposed) resolve(wx);
        });
        wx.error((error) =>
          reject(
            new TianaLocationError("CONFIGURATION", nativeDiagnostic(error)),
          ),
        );
        wx.config({
          debug: false,
          appId: config.app_id,
          timestamp: config.timestamp,
          nonceStr: config.nonce_str,
          signature: config.signature,
          jsApiList: ["getLocation"],
        });
      });
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      stopSetup = () =>
        reject(
          new TianaLocationError(
            disposed ? "DISPOSED" : "CONFIGURATION",
            "WX_SETUP_CANCELLED",
          ),
        );
      abort.signal.addEventListener("abort", stopSetup, { once: true });
      timer = setTimeout(() => {
        reject(new TianaLocationError("CONFIGURATION", "WX_SETUP_TIMEOUT"));
        abort.abort();
      }, 10000);
    });
    const promise = Promise.race([work, deadline])
      .catch((error) => {
        releaseSDK?.();
        throw error instanceof TianaLocationError
          ? error
          : new TianaLocationError("CONFIGURATION", "WX_CONFIGURATION_FAILED");
      })
      .finally(() => {
        clearTimeout(timer);
        if (stopSetup) abort.signal.removeEventListener("abort", stopSetup);
      });
    const attempt = { promise, abort };
    pending = attempt;
    void promise.then(
      (wx) => {
        if (!disposed) {
          configured = wx;
          configuredRelease = releaseSDK;
        }
        if (pending === attempt) pending = undefined;
      },
      () => {
        if (pending === attempt) pending = undefined;
      },
    );
    return promise;
  }
  return Object.freeze({
    getCurrentPosition(
      request: TianaLocationRequestOptions = {},
    ): Promise<TianaPosition> {
      const timeout = request.timeoutMs ?? 20000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
        return Promise.reject(
          new TypeError("timeoutMs must be an integer from 1 to 120000"),
        );
      if (disposed) return Promise.reject(new TianaLocationError("DISPOSED"));
      if (request.signal?.aborted)
        return Promise.reject(new TianaLocationError("ABORTED"));
      if (!view) return Promise.reject(new TianaLocationError("UNSUPPORTED"));
      if (waiters.size >= 32)
        return Promise.reject(new TianaLocationError("BUSY"));
      const started = Date.now();
      return new Promise<TianaPosition>((resolve, reject) => {
        let active = true;
        const finish = (
          error?: TianaLocationError,
          value?: TianaPosition,
        ): void => {
          if (!active) return;
          active = false;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", cancel);
          waiters.delete(fail);
          if (error) reject(error);
          else resolve(value!);
        };
        const fail = (error: TianaLocationError): void => finish(error);
        const cancel = (): void => fail(new TianaLocationError("ABORTED"));
        const timer = setTimeout(
          () => fail(new TianaLocationError("TIMEOUT")),
          timeout,
        );
        waiters.add(fail);
        request.signal?.addEventListener("abort", cancel, { once: true });
        const accept: Callback = (value) => {
          if (!active) return;
          try {
            finish(undefined, position(value, wechat, started));
          } catch (error) {
            fail(
              error instanceof TianaLocationError
                ? error
                : new TianaLocationError("INVALID_RESULT"),
            );
          }
        };
        void (async () => {
          if (request.signal?.aborted) {
            cancel();
            return;
          }
          if (wechat) {
            const wx = await prepare();
            if (!active) return;
            wx.getLocation({
              type: "wgs84",
              success: accept,
              cancel: () => fail(new TianaLocationError("ABORTED")),
              fail: (error) => {
                const message = record(error).errMsg;
                fail(
                  new TianaLocationError(
                    typeof message === "string" &&
                    /deny|denied|auth|permission/i.test(message)
                      ? "PERMISSION_DENIED"
                      : "UNAVAILABLE",
                  ),
                );
              },
            });
          } else {
            const geo = view.navigator.geolocation;
            if (!geo) {
              fail(new TianaLocationError("UNSUPPORTED"));
              return;
            }
            geo.getCurrentPosition(
              accept,
              (error) =>
                fail(
                  new TianaLocationError(
                    (
                      {
                        1: "PERMISSION_DENIED",
                        2: "UNAVAILABLE",
                        3: "TIMEOUT",
                      } as const
                    )[error.code as 1 | 2 | 3] ?? "UNAVAILABLE",
                  ),
                ),
              { enableHighAccuracy: true, maximumAge: 0, timeout },
            );
          }
        })().catch((error) =>
          fail(
            error instanceof TianaLocationError
              ? error
              : new TianaLocationError("UNAVAILABLE"),
          ),
        );
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const fail of waiters) fail(new TianaLocationError("DISPOSED"));
      pending?.abort.abort();
      configuredRelease?.();
      configuredRelease = undefined;
      configured = undefined;
    },
  });
}
