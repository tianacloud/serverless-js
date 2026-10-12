# Serverless account authentication

## Decision: rotating account credentials (2026-09-26)

User authorized access/refresh support and migration of CLI app preview to account
authentication. Keep existing opaque static `tianaToken` support; add exclusive
`auth: TianaAuthProvider`, and `createTianaSessionAuth` with explicit HTTPS MGR
origin and caller-owned credentials/persistence. No environment/file/global
credential discovery, login UI, keep-alive change, or wire-format change.

Invariants:
- Access credentials go only to the outer Gateway authorization header. Refresh
  credentials go only to the configured MGR refresh endpoint; never into frames.
- One provider owns rotation. Cancelled waiters cannot interrupt it. Independent
  providers/processes/tabs require caller coordination; do not add global state.
- Replace access+refresh+expiry together, persist before releasing data, wait for
  MGR tenant-token sync. Persist failures retain the new snapshot. An unresolved
  save cannot be duplicated or overtaken by another rotation.
- Refresh response loss/timeout/malformed success/commit-unknown latches a safe
  error. No replay of a consumed refresh token. MGR does not provide recovery
  idempotency; a new login is needed after an ambiguous outcome or process crash
  before saving a successful rotation.
- No automatic SQL/data retries for any outer error, including 401/403. A failing
  write could have committed. Authentication failures before sending are distinct.
- Bounded management body (64 KiB), bounded management/save wait, exponential
  readiness polling, zero background work at idle. Fast path is in-memory access.
- Errors expose codes and sanitized messages, never tokens or raw response bodies.

Tradeoffs: account access grants are broader than instance grants; browser callers
should use a trusted broker holding refresh tokens. CLI supplies such a provider.
MGR's direct browser CORS is outside this change. Immutable replacement persistence
belongs to the caller; no new storage format/migration. Reverting this feature
restores static-token callers; consumers of the new exports must first migrate.

Validate TS consumers, legacy adapter/golden protocol tests, concurrent refresh,
abort isolation, sync gating, persistence failure/hang, expired/rejected/lost
refresh, no data replay, metadata isolation, and browser/Node runtime behavior.
Deployed MGR/Gateway acceptance must be stated separately from local fixtures.


## Coordinated main publication (2026-09-27)

The user explicitly authorized commit and push to main for cli, agent-skills,
mgr, web and serverless-js, followed by Gaia deployment of MGR and Web. This
supersedes earlier implementation-only publication restrictions for the pending
changes in this session. Preserve all already-reviewed pending work; integrate
remote main without rewriting history. No npm release/version bump is implied.
The paired source association requires the matching client/server rollout and a
new immutable application version. Existing deployment settings and schema 26
remain unchanged. Verify remote commit identities, clean source image provenance,
Gaia success/IN_SYNC and live readiness/auth boundaries after deployment.


## Type-independent data Token authorization

Token scope is independent of instance engine and business channel. Endpoint,
Instance, Group and Tenant credentials may authorize SQLite, Git or Web when
valid and their scope covers the target. Web publication/control still requires
an authenticated credential even when resource reads are anonymous; do not add
an instance-kind whitelist. Preserve expiry, revocation, owner revisions, quota,
instance enablement and protocol checks. Site/project owner/admin policies and
MGR session/tenant/role checks remain separate from data authorization.

CLI Web publication/status uses the same explicit TIANA_TOKEN / TIANA_TOKEN_FILE
precedence as other connections, otherwise the pinned account's access token.
It never reads local instance-token caches or retries with alternate credentials.
The account still resolves MGR project metadata. Unknown publication outcomes
retain their identity/archive and are never automatically replayed. No wire,
schema, token issuance, storage or Gateway–Agent version changes are involved.
This current decision supersedes earlier instance-only Web publication and
account-credentials-never-reach-Gateway guidance.

## Tenant file storage

`createTianaFiles` uses the account provider only for MGR file management. Content
reads use a separate 15-minute file grant: browser Cookie or Node Header.
`getUrl` contains only a public scope selector and does not grant anonymous access.
Hosted WebApp roots come from MGR's Web ID scope. The preview content broker is
same-origin; direct uploads still use OSS. Keep independent transports and do
not route files through database Fetch frames.

Share grant installation across waiters, renew once for explicit file credential
failures, and never replay uncertain uploads or completion automatically. Retain
upload IDs for status/complete/cancel. Signed multipart file Content-Type must
match the policy. Cancel waits for server expiry settlement; it does not revoke
an OSS form. Clear and dispose old clients on identity changes.

Validate Node and browser transports, concurrent renewal/cancel, upload identity
and multipart fields, image failure recovery, and packaged public exports.
