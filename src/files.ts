import { waitFor, type TianaAuthProvider } from "./auth.js";

export interface TianaFile {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly etag?: string;
  readonly modified_at?: string;
  readonly content_type?: string;
}
export interface TianaFilePage { readonly items: readonly TianaFile[]; readonly cursor?: string }
export interface TianaFileCapabilities {
  readonly origin: string;
  readonly max_upload_bytes: number;
  readonly upload_ttl_seconds: number;
  readonly read_ttl_seconds: number;
  readonly file_bytes: string;
  readonly reserved_bytes: string;
  readonly storage_bytes: string;
  readonly storage_limit: string;
}
export interface TianaFileGrant {
  readonly token: string;
  readonly origin: string;
  readonly root: string;
  readonly scope_id: string;
  readonly expires_at: number;
  readonly session_url: string;
}
export interface TianaFileUpload {
  readonly id: string;
  readonly path: string;
  readonly status: string;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly expires_at: number;
  readonly form?: { readonly url: string; readonly fields: Readonly<Record<string, string>>; readonly expires_at: number };
  readonly object?: TianaFile;
}
export interface TianaFileRequestOptions { readonly signal?: AbortSignal }
export interface TianaFilePutOptions extends TianaFileRequestOptions {
  readonly overwrite?: boolean;
  readonly requestId?: string;
  /** Called after reservation so callers can retain the upload identity. */
  readonly onPrepared?: (upload: TianaFileUpload) => void;
  /** Browser upload progress in bytes. Node reports the completed transfer. */
  readonly onProgress?: (loaded: number, total: number) => void;
}
export type TianaFileRequest = (url: string, init: RequestInit) => Promise<Response>;
export type TianaFilesOptions = {
  /** MGR /api/v1/files or the fixed WebApp file-storage BFF URL. */
  readonly apiBaseUrl: string;
  /** File origin override; MGR accepts only the configured environment origins. */
  readonly origin?: string;
  readonly fetch?: typeof globalThis.fetch;
} & (
  | { readonly auth: TianaAuthProvider; readonly request?: never; readonly contentBaseUrl?: never }
  | {
      /** Browser broker handles its existing session and CSRF rotation. */
      readonly request: TianaFileRequest;
      readonly auth?: never;
      /** CLI local preview's same-origin streaming endpoint. */
      readonly contentBaseUrl?: string;
    }
);

export class TianaFileError extends Error {
  constructor(readonly code: string, readonly status: number, readonly uploadId?: string) {
    super(`File operation failed (${code})`);
    this.name = "TianaFileError";
  }
}

function relativePath(path: string, directory = false): string {
  const value = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  if (directory && value === "") return path;
  if (!value || /[\\\x00]/u.test(value) || /%(?:2e|2f|5c|25)/iu.test(value) || value.split("/").some(p => p === "" || p === "." || p === "..")) {
    throw new TypeError("Invalid relative file path");
  }
  return path;
}
function encodedPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
async function requireOK(response: Response, uploadId?: string): Promise<void> {
  if (response.ok) return;
  let code = "FILE_REQUEST_FAILED";
  let id = uploadId;
  if (response.headers.get("content-type")?.includes("application/json")) {
    const value = await response.json().catch(() => null) as { error?: { code?: string; details?: { upload_id?: string } } } | null;
    code = value?.error?.code ?? code;
    id = value?.error?.details?.upload_id ?? id;
  }
  throw new TianaFileError(code, response.status, id);
}
function deniedGrant(response: Response): boolean {
  return response.status === 403 && ["file_grant_invalid", "file_grant_expired"].includes(response.headers.get("x-tiana-file-error") ?? "");
}

export interface TianaFiles {
  capabilities(options?: TianaFileRequestOptions): Promise<TianaFileCapabilities>;
  list(path?: string, options?: TianaFileRequestOptions & { readonly cursor?: string }): Promise<TianaFilePage>;
  metadata(path: string, options?: TianaFileRequestOptions): Promise<TianaFile>;
  ready(options?: TianaFileRequestOptions): Promise<void>;
  getUrl(path: string, options?: TianaFileRequestOptions): Promise<string>;
  get(path: string, options?: TianaFileRequestOptions & { readonly range?: string; readonly method?: "GET" | "HEAD" }): Promise<Response>;
  put(path: string, content: Blob, options?: TianaFilePutOptions): Promise<TianaFileUpload>;
  uploadStatus(id: string, options?: TianaFileRequestOptions): Promise<TianaFileUpload>;
  completeUpload(id: string, options?: TianaFileRequestOptions): Promise<TianaFileUpload>;
  cancelUpload(id: string, options?: TianaFileRequestOptions): Promise<TianaFileUpload>;
  delete(path: string, options?: TianaFileRequestOptions & { readonly requestId?: string }): Promise<void>;
  /** Install before src assignment; refresh once after a confirmed credential failure. */
  bindImage(image: HTMLImageElement, path: string, options?: TianaFileRequestOptions): Promise<() => void>;
  /** Clear this scope's file cookie when switching tenant or logging out. */
  clear(): Promise<void>;
  dispose(): void;
}

/** File credentials and account credentials use separate transports and caches. */
export function createTianaFiles(options: TianaFilesOptions): TianaFiles {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBase = options.apiBaseUrl.replace(/\/$/u, "");
  const browser = options.auth === undefined;
  const lifetime = new AbortController();
  let cached: TianaFileGrant | undefined;
  let installedCookie: TianaFileGrant | undefined;
  let installing: Promise<TianaFileGrant> | undefined;
  let generation = 0;
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;

  async function api<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const scopedSignal = signalFor(signal);
    scopedSignal.throwIfAborted();
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    if (options.auth) headers.set("authorization", `Bearer ${await options.auth.getAccessToken({ signal: scopedSignal })}`);
    const init: RequestInit = { method, headers, signal: scopedSignal, credentials: browser ? "same-origin" : "omit", redirect: "error", cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const response = await (options.request ?? fetchImpl)(apiBase + path, init);
    await requireOK(response);
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
  function grant(force = false): Promise<TianaFileGrant> {
    lifetime.signal.throwIfAborted();
    if (installing) return installing;
    if (!force && cached && cached.expires_at * 1000 > Date.now() + 30_000) return Promise.resolve(cached);
    const started = generation;
    installing = (async () => {
      const timeout = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
      const next = await api<TianaFileGrant>("/read-grant", "POST", { ...(options.origin ? { origin: options.origin } : {}) }, timeout);
      if (browser) {
        const response = await fetchImpl(next.session_url, { method: "POST", headers: { authorization: `Bearer ${next.token}` }, credentials: "include", redirect: "error", cache: "no-store", signal: timeout });
        await requireOK(response);
        installedCookie = next;
      }
      if (started !== generation) throw new DOMException("File session changed", "AbortError");
      cached = next;
      return next;
    })().finally(() => { installing = undefined; });
    return installing;
  }
  function urlFor(path: string, g: TianaFileGrant): string {
    return `${g.origin}${encodedPath(g.root)}${encodedPath(relativePath(path))}?_fs_scope=${encodeURIComponent(g.scope_id)}`;
  }
  function localUrl(path: string): string {
    return `${options.contentBaseUrl}?path=${encodeURIComponent(relativePath(path))}`;
  }
  async function content(path: string, init: TianaFileRequestOptions & { readonly range?: string; readonly method?: "GET" | "HEAD" } = {}): Promise<Response> {
    relativePath(path);
    const signal = signalFor(init.signal);
    if (options.contentBaseUrl) {
      const response = await fetchImpl(localUrl(path), { method: init.method ?? "GET", headers: init.range ? { range: init.range } : {}, credentials: "same-origin", redirect: "error", cache: "no-store", signal });
      await requireOK(response); return response;
    }
    let g = await waitFor(grant(), signal);
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers();
      if (!browser) headers.set("authorization", `Bearer ${g.token}`);
      if (init.range) headers.set("range", init.range);
      const response = await fetchImpl(urlFor(path, g), { method: init.method ?? "GET", headers, credentials: browser ? "include" : "omit", redirect: "error", cache: "no-store", signal });
      if (attempt === 0 && deniedGrant(response)) {
        await response.body?.cancel();
        g = await waitFor(cached && cached !== g ? Promise.resolve(cached) : grant(true), signal);
        continue;
      }
      await requireOK(response); return response;
    }
  }
  async function upload(form: NonNullable<TianaFileUpload["form"]>, blob: Blob, path: string, opt: TianaFilePutOptions, id: string): Promise<void> {
    const data = new FormData();
    for (const [name, value] of Object.entries(form.fields)) data.append(name, value);
    // OSS checks the multipart file Content-Type against the signed form value.
    data.append("file", new Blob([blob], { type: form.fields["Content-Type"] ?? "application/octet-stream" }), path.split("/").at(-1)!);
    const signal = signalFor(opt.signal);
    if (opt.onProgress && typeof XMLHttpRequest !== "undefined") {
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const done = () => signal.removeEventListener("abort", abort);
        xhr.open("POST", form.url); xhr.withCredentials = false;
        xhr.upload.onprogress = event => opt.onProgress?.(Math.min(event.loaded, blob.size), blob.size);
        xhr.onload = () => { done(); if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new TianaFileError("FILE_UPLOAD_FAILED", xhr.status, id)); };
        xhr.onerror = () => { done(); reject(new TianaFileError("FILE_UPLOAD_UNCERTAIN", 0, id)); };
        xhr.onabort = () => { done(); reject(signal.reason ?? new DOMException("Upload aborted", "AbortError")); };
        signal.addEventListener("abort", abort, { once: true });
        xhr.send(data);
      });
    } else {
      const response = await fetchImpl(form.url, { method: "POST", body: data, credentials: "omit", redirect: "error", signal });
      await requireOK(response, id);
      opt.onProgress?.(blob.size, blob.size);
    }
  }
  const client: TianaFiles = {
    capabilities: (opt = {}) => api("/capabilities", "GET", undefined, opt.signal),
    list: (path = "", opt = {}) => api(`/list?path=${encodeURIComponent(relativePath(path, true))}&cursor=${encodeURIComponent(opt.cursor ?? "")}`, "GET", undefined, opt.signal),
    metadata: (path, opt = {}) => api(`/metadata?path=${encodeURIComponent(relativePath(path))}`, "GET", undefined, opt.signal),
    async ready(opt = {}) { if (!options.contentBaseUrl) await waitFor(grant(), signalFor(opt.signal)); },
    async getUrl(path, opt = {}) { relativePath(path); return options.contentBaseUrl ? localUrl(path) : urlFor(path, await waitFor(grant(), signalFor(opt.signal))); },
    get: content,
    async put(path, blob, opt = {}) {
      relativePath(path);
      const prepared = await api<TianaFileUpload>("/uploads", "POST", { path, size: blob.size, content_type: blob.type || "application/octet-stream", request_id: opt.requestId ?? crypto.randomUUID(), overwrite: opt.overwrite ?? false }, opt.signal);
      opt.onPrepared?.(prepared);
      if (prepared.completed) return prepared;
      if (!prepared.form) throw new TianaFileError("FILE_UPLOAD_NOT_READY", 409, prepared.id);
      try { await upload(prepared.form, blob, path, opt, prepared.id); }
      catch (error) {
        if (error instanceof TianaFileError || opt.signal?.aborted) throw error;
        throw new TianaFileError("FILE_UPLOAD_UNCERTAIN", 0, prepared.id);
      }
      try { return await client.completeUpload(prepared.id, opt); }
      catch (error) {
        if (error instanceof TianaFileError) throw new TianaFileError(error.code, error.status, prepared.id);
        throw new TianaFileError("FILE_COMPLETE_UNCERTAIN", 0, prepared.id);
      }
    },
    uploadStatus: (id, opt = {}) => api(`/uploads/${encodeURIComponent(id)}`, "GET", undefined, opt.signal),
    completeUpload: (id, opt = {}) => api(`/uploads/${encodeURIComponent(id)}/complete`, "POST", {}, opt.signal),
    cancelUpload: (id, opt = {}) => api(`/uploads/${encodeURIComponent(id)}/cancel`, "POST", {}, opt.signal),
    async delete(path, opt = {}) { await api(`/object?path=${encodeURIComponent(relativePath(path))}`, "DELETE", { request_id: opt.requestId ?? crypto.randomUUID() }, opt.signal); },
    async bindImage(image, path, opt = {}) {
      let removed = false;
      let checked = false;
      const failed = () => {
        if (removed || checked) return;
        checked = true;
        void content(path, { ...opt, method: "HEAD" }).then(() => client.getUrl(path, opt)).then(url => { if (!removed) image.src = url; }).catch(() => undefined);
      };
      const url = await client.getUrl(path, opt);
      image.addEventListener("error", failed);
      image.src = url;
      return () => { removed = true; image.removeEventListener("error", failed); };
    },
    async clear() {
      generation++;
      const active = installing;
      cached = undefined;
      if (active) await active.catch(() => undefined);
      const previous = installedCookie;
      installedCookie = undefined;
      if (browser && previous) {
        const response = await fetchImpl(previous.session_url, { method: "DELETE", headers: { authorization: `Bearer ${previous.token}` }, credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
        await requireOK(response);
      }
    },
    dispose() { generation++; cached = undefined; lifetime.abort(); },
  };
  return client;
}
