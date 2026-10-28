import { waitFor } from "./auth.js";

export interface TianaFunctionConnection {
  readonly instance_id: string;
  readonly origin: string;
  readonly token: string;
  /** Absolute Unix seconds, supplied by the credential issuer. */
  readonly expires_at: number;
}

export interface TianaFunctionsOptions {
  /** Bound to one authenticated Site or Console context. */
  readonly connection: (
    instanceId: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<TianaFunctionConnection>;
  /** Direct Gateway transport, independent of the connection issuer. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface TianaFunctions {
  fetch(instanceId: string, path: string, init?: RequestInit): Promise<Response>;
  /** Discard credentials and cancel outstanding work when the context ends. */
  dispose(): void;
}

/** One client per login context; no persistence or automatic business retries. */
export function createTianaFunctions(options: TianaFunctionsOptions): TianaFunctions {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const lifetime = new AbortController();
  const credentials = new Map<string, TianaFunctionConnection>();
  const pending = new Map<string, Promise<TianaFunctionConnection>>();

  function active(): void {
    lifetime.signal.throwIfAborted();
  }
  function usable(value: TianaFunctionConnection): boolean {
    return value.expires_at * 1000 > Date.now();
  }
  function validate(instanceId: string, value: TianaFunctionConnection): TianaFunctionConnection {
    let origin: URL;
    try { origin = new URL(value.origin); }
    catch { throw new Error("Invalid Function connection"); }
    if (value.instance_id !== instanceId || origin.protocol !== "https:" ||
        origin.username || origin.password || origin.pathname !== "/" ||
        origin.search || origin.hash || typeof value.token !== "string" ||
        !value.token || /[\s\x00-\x1f\x7f]/u.test(value.token) || !Number.isSafeInteger(value.expires_at) || !usable(value)) {
      throw new Error("Invalid or expired Function connection");
    }
    return Object.freeze({ ...value, origin: origin.origin });
  }
  async function connection(instanceId: string): Promise<TianaFunctionConnection> {
    active();
    const cached = credentials.get(instanceId);
    if (cached && usable(cached)) return cached;
    credentials.delete(instanceId);
    let current = pending.get(instanceId);
    if (!current) {
      // The existing browser management wait is bounded independently of callers.
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
      current = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        const value = validate(instanceId, await waitFor(options.connection(instanceId, { signal }), signal));
        active();
        credentials.set(instanceId, value);
        return value;
      }).finally(() => { pending.delete(instanceId); });
      pending.set(instanceId, current);
    }
    return current;
  }

  return Object.freeze({
    async fetch(instanceId: string, path: string, init: RequestInit = {}): Promise<Response> {
      active();
      const signal = init.signal
        ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal;
      signal.throwIfAborted();
      const credential = await waitFor(connection(instanceId), signal);
      signal.throwIfAborted();
      if (!usable(credential)) {
        credentials.delete(instanceId);
        throw new Error("Function credential expired before dispatch");
      }
      const url = new URL(path, credential.origin);
      if (url.origin !== credential.origin || url.username || url.password) {
        throw new TypeError("Function request must use its authorized origin");
      }
      const headers = new Headers(init.headers);
      headers.set("Authorization", "Bearer " + credential.token);
      const response = await transport(url, {
        ...init, headers, signal, credentials: "omit", redirect: "error",
      });
      if ((response.status === 401 || response.status === 403) && credentials.get(instanceId) === credential) {
        credentials.delete(instanceId);
      }
      return response;
    },
    dispose(): void {
      lifetime.abort(new DOMException("Function context ended", "AbortError"));
      credentials.clear();
      pending.clear();
    },
  });
}
