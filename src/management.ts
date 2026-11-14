import { TianaAuthError, waitFor, type TianaAuthProvider } from './auth.js';
import { createRequestId } from './diagnostics.js';
import type {
  AppTypeCatalog, Instance, InstancePage, CreateInstanceInput, EditInstanceInput,
  InstanceOperationAccepted, InstanceBranchPage, InstanceBranchDetail,
  InstanceOperation, InstanceOperationStepsPage, BranchHistoryResponse,
} from './management-types.js';

export interface TianaCredential {
  accessToken: string;
  expiresAt: number;
  sessionId: string;
}
export interface TianaClientOptions {
  managementOrigin: string | URL;
  getCredential: () => Promise<TianaCredential | null>;
}
export interface ManagementOptions { signal?: AbortSignal; requestId?: string }
export interface ManagementResult<T> { data: T; response: Response }
export interface InstanceQuery {
  page?: number; pageSize?: number; product_family?: string; search?: string;
  state?: string; group_id?: string; engine?: string;
}
export interface BranchQuery { after?: string; search?: string; name?: string }
export interface ConnectionTarget { instanceId: string; branchId?: string }
export interface TianaConnection {
  instanceId: string; branchId: string | null; endpointId: string;
  origin: string; engine: string; auth: TianaAuthProvider;
}
interface ConnectionGrant {
  instance_id: string; branch_id: string | null; endpoint_id: string;
  origin: string; engine: string; token: string; expires_at: number;
}
export class TianaManagementError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  constructor(readonly response: Response, readonly body: unknown) {
    const error = (body as {error?: {code?: string; message?: string}} | null)?.error;
    super(error?.message);
    this.name = 'TianaManagementError';
    this.status = response.status;
    this.code = error?.code;
    this.requestId = response.headers.get('X-Request-ID') ?? undefined;
  }
}
export class TianaConnectionError extends Error {
  readonly code = 'CONNECTION_CHANGED';
  constructor() { super('Connection target changed; obtain a new connection'); this.name = 'TianaConnectionError'; }
}

const loginRequired = () => new TianaAuthError('AUTH_LOGIN_REQUIRED');
const pathPart = encodeURIComponent;
const instancePath = (id: string) => `/api/v1/instances/${pathPart(id)}`;
const branchPath = (id: string, branch: string) => `${instancePath(id)}/branches/${pathPart(branch)}`;
function queryPath(path: string, values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  return query.size ? `${path}?${query}` : path;
}

/** A page-local client. The customer supplies its own credential transport. */
export function createTianaClient(options: TianaClientOptions) {
  const origin = new URL(options.managementOrigin).origin;
  let credential: TianaCredential | null = null;
  let epoch = 0;
  let fetching: Promise<TianaCredential | null> | undefined;
  const grants = new Map<string, ConnectionGrant>();
  const pendingGrants = new Map<string, Promise<ConnectionGrant>>();
  function invalidate() { epoch++; grants.clear(); pendingGrants.clear(); }
  function clearSession() { invalidate(); credential = null; fetching = undefined; }
  function checkEpoch(expected: number) { if (epoch !== expected) throw loginRequired(); }
  function getCredential(force = false): Promise<TianaCredential | null> {
    if (!force && credential && credential.expiresAt - Date.now() > 30_000) return Promise.resolve(credential);
    if (fetching) return fetching;
    const started = epoch;
    const work = Promise.resolve().then(options.getCredential).then(value => {
      checkEpoch(started);
      if (credential && (!value || credential.sessionId !== value.sessionId)) invalidate();
      credential = value ? { ...value } : null;
      return credential;
    });
    fetching = work;
    void work.finally(() => { if (fetching === work) fetching = undefined; }).catch(() => undefined);
    return work;
  }
  async function request<T>(method: string, path: string, input?: unknown, opts: ManagementOptions = {}, revision?: string, binding?: {epoch: number; sessionId: string}): Promise<ManagementResult<T>> {
    opts.signal?.throwIfAborted();
    const requestedEpoch = epoch;
    const initial = await waitFor(getCredential(), opts.signal);
    checkEpoch(requestedEpoch);
    if (!initial) throw loginRequired();
    if (binding) {
      checkEpoch(binding.epoch);
      if (initial.sessionId !== binding.sessionId) throw loginRequired();
    }
    const started = epoch;
    const requestId = opts.requestId ?? createRequestId();
    const body = input === undefined ? undefined : JSON.stringify(input);
    async function send(auth: TianaCredential) {
      checkEpoch(started);
      opts.signal?.throwIfAborted();
      const headers = new Headers({ Authorization: `Bearer ${auth.accessToken}`, 'X-Request-ID': requestId });
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      if (revision !== undefined) headers.set('If-Match', revision);
      const response = await fetch(origin + path, {
        method, headers, credentials: 'omit', redirect: 'error',
        ...(body === undefined ? {} : { body }), ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const text = await response.text();
      let data: unknown;
      try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
      checkEpoch(started);
      if (!response.ok) throw new TianaManagementError(response, data);
      return { data: data as T, response };
    }
    try { return await send(initial); } catch (error) {
      if (!(error instanceof TianaManagementError) || error.status !== 401 || error.code !== 'AUTHENTICATION_REQUIRED') throw error;
      const current = credential;
      const renewed = current && current.sessionId === initial.sessionId && current.accessToken !== initial.accessToken && current.expiresAt > Date.now()
        ? current : await waitFor(getCredential(true), opts.signal);
      if (!renewed || renewed.sessionId !== initial.sessionId || renewed.accessToken === initial.accessToken) throw error;
      return send(renewed);
    }
  }
  function idempotent<T>(method: string, path: string, input: {request_id?: string}, opts: ManagementOptions = {}) {
    const requestId = opts.requestId ?? createRequestId();
    return request<T>(method, path, { ...input, request_id: input.request_id ?? requestId }, { ...opts, requestId });
  }
  async function grant(target: ConnectionTarget, sessionId: string, started: number, requestId?: string): Promise<ConnectionGrant> {
    checkEpoch(started);
    if (credential?.sessionId !== sessionId) throw loginRequired();
    const key = JSON.stringify([sessionId, target.instanceId, target.branchId ?? null]);
    const saved = grants.get(key);
    if (saved && saved.expires_at * 1000 - Date.now() > 30_000) return saved;
    const pending = pendingGrants.get(key);
    if (pending) return pending;
    const work = request<ConnectionGrant>('POST', '/api/v1/integrations/connections', {
      instance_id: target.instanceId, ...(target.branchId === undefined ? {} : { branch_id: target.branchId }),
    }, requestId === undefined ? {} : {requestId}, undefined, {epoch: started, sessionId}).then(({data}) => {
      checkEpoch(started);
      if (credential?.sessionId !== sessionId) throw loginRequired();
      grants.set(key, data);
      return data;
    });
    pendingGrants.set(key, work);
    void work.finally(() => { if (pendingGrants.get(key) === work) pendingGrants.delete(key); }).catch(() => undefined);
    return work;
  }
  const accepted = (method: string, path: string, input?: unknown, opts?: ManagementOptions) => request<InstanceOperationAccepted>(method, path, input, opts);
  return {
    clearSession,
    async session(opts: ManagementOptions = {}) {
      opts.signal?.throwIfAborted();
      const requestedEpoch = epoch;
      const auth = await waitFor(getCredential(), opts.signal);
      if (!auth) return { connected: false as const, session: null };
      checkEpoch(requestedEpoch);
      const {data} = await request<{principal_id: string; tenant_id: string; email: string}>('GET', '/api/v1/me', undefined, opts, undefined, {epoch, sessionId: auth.sessionId});
      return { connected: true as const, session: { session_id: auth.sessionId, user_id: data.principal_id, tenant_id: data.tenant_id, email: data.email } };
    },
    appTypes: { list: (opts?: ManagementOptions) => request<AppTypeCatalog>('GET', '/api/v1/app-types', undefined, opts) },
    instances: {
      list: (query: InstanceQuery = {}, opts?: ManagementOptions) => {
        const {page = 1, pageSize = 20, ...rest} = query;
        return request<InstancePage>('GET', queryPath('/api/v1/instances', {page, page_size: pageSize, ...rest}), undefined, opts);
      },
      get: (id: string, opts?: ManagementOptions) => request<Instance>('GET', instancePath(id), undefined, opts),
      create: (input: CreateInstanceInput, opts?: ManagementOptions) => idempotent<InstanceOperationAccepted>('POST', '/api/v1/instances', input, opts),
      update: (id: string, revision: string, input: EditInstanceInput, opts?: ManagementOptions) => request<Instance>('PATCH', instancePath(id), input, opts, revision),
      setEnabled: (id: string, enabled: boolean, opts?: ManagementOptions) => accepted('POST', `${instancePath(id)}/enabled`, {enabled}, opts),
      delete: (id: string, input: {request_id?: string; delete_git?: boolean} = {}, opts?: ManagementOptions) => idempotent<InstanceOperationAccepted>('DELETE', instancePath(id), input, opts),
    },
    branches: {
      list: (id: string, query: BranchQuery = {}, opts?: ManagementOptions) => request<InstanceBranchPage>('GET', queryPath(`${instancePath(id)}/branches`, query), undefined, opts),
      get: (id: string, branch: string, opts?: ManagementOptions) => request<InstanceBranchDetail>('GET', branchPath(id, branch), undefined, opts),
      create: (id: string, parent: string, input: {name: string; ttl_seconds: number | null}, opts?: ManagementOptions) => accepted('POST', `${branchPath(id, parent)}/children`, input, opts),
      rename: (id: string, branch: string, name: string, opts?: ManagementOptions) => accepted('POST', `${branchPath(id, branch)}/rename`, {name}, opts),
      reset: (id: string, branch: string, input: {mode: 'parent_latest'} | {mode: 'self_history'; timestamp: number}, opts?: ManagementOptions) => accepted('POST', `${branchPath(id, branch)}/reset`, input, opts),
      setProtection: (id: string, branch: string, protectedValue: boolean, opts?: ManagementOptions) => accepted('POST', `${branchPath(id, branch)}/protection`, {protected: protectedValue}, opts),
      setExpiry: (id: string, branch: string, ttlSeconds: number | null, opts?: ManagementOptions) => accepted('POST', `${branchPath(id, branch)}/expiry`, {ttl_seconds: ttlSeconds}, opts),
      setTimeline: (id: string, branch: string, input: {enabled: boolean; retention_seconds?: number}, opts?: ManagementOptions) => accepted('POST', `${branchPath(id, branch)}/timeline`, input, opts),
      delete: (id: string, branch: string, opts?: ManagementOptions) => accepted('DELETE', branchPath(id, branch), undefined, opts),
      history: (id: string, branch: string, opts?: ManagementOptions) => request<BranchHistoryResponse>('GET', `${branchPath(id, branch)}/history`, undefined, opts),
    },
    operations: {
      get: (id: string, operation: string, opts?: ManagementOptions) => request<InstanceOperation>('GET', `${instancePath(id)}/operations/${pathPart(operation)}`, undefined, opts),
      steps: (id: string, operation: string, after?: string, opts?: ManagementOptions) => request<InstanceOperationStepsPage>('GET', queryPath(`${instancePath(id)}/operations/${pathPart(operation)}/steps`, {after}), undefined, opts),
    },
    connections: {
      async get(target: ConnectionTarget, opts: ManagementOptions = {}): Promise<TianaConnection> {
        opts.signal?.throwIfAborted();
        const requestedEpoch = epoch;
        const auth = await waitFor(getCredential(), opts.signal);
        checkEpoch(requestedEpoch);
        if (!auth) throw loginRequired();
        const started = epoch;
        const fixedTarget = {...target};
        const initial = await waitFor(grant(fixedTarget, auth.sessionId, started, opts.requestId), opts.signal);
        checkEpoch(started);
        return {
          instanceId: initial.instance_id, branchId: initial.branch_id, endpointId: initial.endpoint_id,
          origin: initial.origin, engine: initial.engine,
          auth: { async getAccessToken(wait = {}) {
            wait.signal?.throwIfAborted();
            checkEpoch(started);
            const value = await waitFor(grant(fixedTarget, auth.sessionId, started), wait.signal);
            checkEpoch(started);
            if (value.endpoint_id !== initial.endpoint_id || value.origin !== initial.origin) throw new TianaConnectionError();
            return value.token;
          } },
        };
      },
    },
  };
}
export type TianaClient = ReturnType<typeof createTianaClient>;
