import type { TianaFetch } from "./index.js";

export interface VaultEntry { readonly key: string; readonly version: string }
export interface VaultSecret extends VaultEntry { readonly value: string }
export interface VaultSetResult extends VaultEntry { readonly changed: boolean }
export interface VaultPage { readonly items: readonly VaultEntry[]; readonly next_cursor: string | null }
export type VaultSigner = (instanceId: string, key: string, timestamp: number) => Promise<Headers>;

/** The key is non-exportable and lives only as long as the caller retains this signer. */
export async function createVaultSigner(passphrase: string): Promise<VaultSigner> {
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(passphrase.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
  catch { throw new Error("Invalid Vault passphrase"); }
  if (bytes.byteLength !== 16) { bytes.fill(0); throw new Error("Invalid Vault passphrase"); }
  let cryptoKey: CryptoKey;
  try { cryptoKey = await crypto.subtle.importKey("raw", bytes, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]); }
  finally { bytes.fill(0); }
  return async (instance, key, timestamp) => {
    const fields = [instance, "GET", key].map(field => new TextEncoder().encode(field));
    const message = new Uint8Array(fields.reduce((size, field) => size + 8 + field.byteLength, 8));
    const view = new DataView(message.buffer);
    let offset = 0;
    for (const field of fields) { view.setBigUint64(offset, BigInt(field.byteLength)); offset += 8; message.set(field, offset); offset += field.byteLength; }
    view.setBigInt64(offset, BigInt(timestamp));
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
    return new Headers({"x-tiana-vault-time": String(timestamp), "x-tiana-vault-signature": btoa(String.fromCharCode(...signature))});
  };
}

export class VaultError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code === "NOT_EXIST" ? "Secret does not exist" : code === "SIGNATURE_EXPIRED" ? "Vault Get signature expired" : code === "INVALID_SIGNATURE" ? "Invalid Vault passphrase or signature" : "Vault request failed");
    this.name = "VaultError";
  }
}
export interface TianaVault {
  Get(key: string, signer: VaultSigner, signal?: AbortSignal): Promise<VaultSecret>;
  Set(key: string, value: string, signal?: AbortSignal): Promise<VaultSetResult>;
  Remove(key: string, signal?: AbortSignal): Promise<void>;
  List(options?: {keyword?: string; after?: string; pageSize?: number; signal?: AbortSignal}): Promise<VaultPage>;
}

/** Use an already-authorized tiana-http transport. No retries or credential persistence. */
export function createTianaVault(options: {instanceId: string; origin: string; fetch: TianaFetch}): TianaVault {
  const path = (key: string) => "/secrets/" + encodeURIComponent(key);
  async function call<T>(method: string, pathname: string, body?: string, headers?: Headers, signal?: AbortSignal): Promise<T> {
    const response = await options.fetch(new URL(pathname, options.origin), {method, ...(body === undefined ? {} : {body}), ...(headers ? {headers} : {}), ...(signal ? {signal} : {})});
    if (!response.ok) {
      let code = "VAULT_REQUEST_FAILED";
      try { const value = await response.json() as {error?: {code?: string}}; code = value.error?.code ?? code; } catch { /* Keep the status without exposing the response body. */ }
      throw new VaultError(code, response.status);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  return Object.freeze({
    async Get(key: string, signer: VaultSigner, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const headers = await signer(options.instanceId, key, Math.floor(Date.now() / 1000));
      signal?.throwIfAborted();
      return call<VaultSecret>("GET", path(key), undefined, headers, signal);
    },
    Set: (key: string, value: string, signal?: AbortSignal) => call<VaultSetResult>("PUT", path(key), JSON.stringify({value}), new Headers({"Content-Type":"application/json"}), signal),
    Remove: (key: string, signal?: AbortSignal) => call<void>("DELETE", path(key), undefined, undefined, signal),
    List: (value: {keyword?: string; after?: string; pageSize?: number; signal?: AbortSignal} = {}) => {
      const query = new URLSearchParams({keyword: value.keyword ?? "", after: value.after ?? "", page_size: String(value.pageSize ?? 50)});
      return call<VaultPage>("GET", "/secrets?" + query, undefined, undefined, value.signal);
    },
  });
}
