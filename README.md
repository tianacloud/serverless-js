# `@tianacloud/serverless`

`@tianacloud/serverless` is the JavaScript/TypeScript Custom Fetch adapter for
Tiana Fetch-over-HTTPS v1. It converts one standard same-origin `fetch()`
request into a TFQ1 request to the Tiana Gateway and exposes the TFS1 inner
response as a standard `Response`.

Install the stable release with `npm install @tianacloud/serverless`. Its historical Fetch v1 compatibility baseline is
Contracts release `v0.17.2-rc.1` at commit
`d252fd7bf689657e50b6caf36298f8c57860df6b` (annotated tag object
`fb4fdf07f6e5b86eb00562f07dccf7bd120cd0f2`).

## Intended use

```ts
import { createTianaFetch } from "@tianacloud/serverless";

const databaseOrigin =
  "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.example.test";

const tianaFetch = createTianaFetch({
  origin: databaseOrigin,
  tianaToken: process.env.TIANA_TOKEN!,
});

// Pass `tianaFetch` as the custom Fetch implementation of the database
// client. The database client's Authorization header remains an inner header;
// the Tiana Token is used only for the outer Gateway request.
```

The adapter accepts `RequestInfo | URL` plus an optional `RequestInit`, uses
the platform `Request` constructor for normalization, and rejects any request
whose normalized origin differs from the configured origin. It performs one
outer request and never retries automatically.

Tokens are opaque credential strings, forwarded unchanged to Gateway in the
outer Authorization header. The adapter does not interpret their scope or encoding.

The configured HTTPS origin uses a v1 Endpoint ID
(`ep-[0-7][0-9a-hjkmnp-tv-z]{25}`) followed by the deployment's Endpoint DNS
suffix and port. Use the Endpoint address published by Gaia through the
connection configuration. Requests must use that same normalized origin.
Hosts without a v1 Endpoint ID, IP literals, paths, queries, fragments,
and embedded credentials are rejected before transport.

Browser transports can set `requestBodyMode: "buffered"` for native data
requests. HTTP data requests are always buffered. Responses remain streamed.

## App HTTP data API

```ts
const http = createTianaFetch({
  origin: databaseOrigin,
  tianaToken,
  protocol: "tiana-http",
});
const response = await http(`${databaseOrigin}/v1/sql`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sql: "SELECT 1 AS answer;" }),
});
const result = await response.json();
```

Inner `Accept-Encoding`, `Content-Encoding` and representation `Content-Length`
are preserved. The response body contains the encoded bytes; the adapter does
not decompress or recompress them. Consumers parsing JSON can explicitly request
inner `Accept-Encoding: identity`. Outer Fetch frame validation is unchanged.

For Web publication, `protocol: "tiana-http"` selects existing channel=1 and
http-data.sock; use PUT /_tiana/web/publish and GET control status endpoints.
A valid Token whose Endpoint, Instance, Group or Tenant scope covers the target
is required for those endpoints, even if resource reads are anonymous. Token
authorization is independent of the instance engine and channel; the adapter
passes the supplied credential unchanged and does not select a Token kind. No channel option exists. Web resources use native HTTP through
CONNECT channel=0/data.sock (the Web BFF handles browser access); they do not use
the HTTP control adapter. Gateway–Agent handshake stays v4.

The optional protocol is top-level Fetch metadata, consumed by Gateway to
select the App HTTP data socket. Omitting it selects the existing native data
socket. Gateway forwards the inner path; `/v1/sql` belongs to the SQLite App.

The HTTP data adapter reads the complete request body before sending its
binary frame and retains streaming response decoding. It uses the existing
request-size bound and does not require browser request-stream support.
Abort cancels this call; requests are never replayed. Gateway handles CORS
preflight for arbitrary browser origins; actual requests retain Tiana Token
authorization and use `credentials: "omit"`.

Each call owns an independent App connection. Send `BEGIN; ...; COMMIT;` in
one request. Separate calls do not share a connection transaction or TEMP
state; SQL errors and partial success keep the App's existing semantics.

## Buffered frame codec

Protocol tools and test fixtures can use the public `@tianacloud/serverless/codec`
entry point instead of importing internal `dist` files:

```ts
import {
  decodeRequestFrameBytes,
  encodeResponseFrameBytes,
} from "@tianacloud/serverless/codec";

const request = decodeRequestFrameBytes(requestBytes);
const body = new TextEncoder().encode('{"entries":[]}');
const responseBytes = encodeResponseFrameBytes({
  metadata_version: 1,
  request_id: request.metadata.request_id,
  status: 200,
  status_text: "OK",
  headers: [{ name: "content-type", value: "application/json" }],
  body_length: body.byteLength,
}, body);
```

This entry point exports `encodeRequestFrameBytes`, `decodeRequestFrameBytes`,
`encodeResponseFrameBytes`, and `decodeResponseFrameBytes`, plus the
`DecodedRequestFrame`, `DecodedResponseFrame`, `FetchHeader`, `FetchMethod`,
`FetchRequestMetadata`, and `FetchResponseMetadata` types. The response decoder
accepts an optional `{ requestId, method }` argument to check response correlation
and HEAD semantics. Invalid frames throw `TianaFetchProtocolError`, available
from the main package entry point.

These functions buffer complete Fetch v1 frames and apply the existing metadata
and body validation. They do not send requests or perform authentication. Keep
credentials in the outer transport authorization header, outside the frames.
Streaming helpers and internal `dist/*` paths are not public API. Ordinary
application callers should continue using `createTianaFetch`.

A mock server using the same codec verifies client integration; it does not
independently prove Gateway interoperability. The conformance tests also compare
local codec output with the checked-in golden protocol bytes; the installed-package
test separately checks the public entry point against golden response bytes.

## Request diagnostics

The adapter generates a request ID before network I/O and sends the same ID
in the outer `X-Request-ID` header and TFQ1 metadata. Use `onDiagnostic` for
failures that occur before a `Response` exists and for response body errors:

```ts
import { createTianaFetch, diagnosisOf } from "@tianacloud/serverless";

const http = createTianaFetch({
  origin: databaseOrigin,
  tianaToken,
  onDiagnostic(event) {
    if (event.phase === "failed") console.error("Tiana request", event.requestId);
  },
});

try {
  const response = await http(`${databaseOrigin}/v1/sql`);
  console.log(diagnosisOf(response)?.requestId);
  await response.text();
} catch (error) {
  console.error(diagnosisOf(error)?.requestId);
}
```

`diagnosisOf` accepts the original `Request`, returned `Response`, or an
object-shaped error. A primitive Abort reason is available through
`onDiagnostic`. The latest phase becomes `completed` only after a streamed
body is fully read, or `cancelled`/`failed` when it stops early. Reading the
diagnostic does not consume the body. A callback exception does not change
the Fetch result.

## Publishing

GitHub Actions runs the package checks on pull requests and branch pushes. To
release, update `package.json` and push a matching `v<version>` tag. The
`.github/workflows/release.yml` workflow checks, builds and publishes the package
directly to npm using trusted publishing. The manual workflow trigger checks the
selected ref by default; select `publish` to publish its package version.

Configure npm's trusted publisher once for package `@tianacloud/serverless`,
repository `tianacloud/serverless-js`, workflow `release.yml`, with direct
publishing allowed. GitHub-hosted runners use OIDC; publication requires no stored
npm token or per-release browser verification. npm may require account 2FA when
initially creating this relationship. Stable releases use the package's `latest` tag.

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm check
```

The runtime has no production dependencies and uses only standard Fetch,
Web Streams, URL, Encoding, and Web Crypto APIs. Node, Bun and Deno have local
runtime test coverage. Record the runtime version and executed checks when
reporting results.

With Deno installed, run the package smoke test and existing diagnostic suite:

```sh
corepack pnpm build
deno run --allow-read --node-modules-dir=manual tests/runtime-smoke.mjs
deno test --allow-read --node-modules-dir=manual tests/adapter.test.mjs tests/conformance.test.mjs tests/provenance.test.mjs
```

These checks use local transport fixtures. Deployed Gateway, network failures
and hosted edge environments need their own runtime evidence.

`pnpm test:browser` exercises request diagnostics in Chromium against a local
cross-origin HTTPS/H2 fixture. It covers buffered and streamed requests,
outer and inner errors, truncated bodies, socket reset, DNS/TLS failure,
AbortSignal before and after headers, body cancellation, CORS rejection,
observer failures, and concurrent identities.
The test needs OpenSSL to create a temporary certificate and removes its
temporary files when finished. It does not contact a deployed Tiana environment.

The SDK owns its codec, limits, and behavior tests. The byte vectors under
`tests/fixtures` retain their historical provenance and remain local regression
inputs. Build, test, and packaging do not read a Contracts or Specifications
checkout, fetch a historical distribution, or validate a central Schema.

For cross-implementation testing, `tests/gateway-interop.mjs` accepts an
unpacked SDK package's `dist/index.js` and a Gateway loopback fixture JSON as
explicit arguments. It imports the packaged adapter and exchanges requests
with the real Rust ingress over TLS H1/H2. Its Node HTTP transport preserves
SDK-produced frame bytes and maps the configured Endpoint to loopback using
the fixture certificate. Gateway's `docs/fetch-interop.md` describes the
fixture lifecycle and backend test doubles. This optional test does not run
as part of the standalone SDK suite.

The optional `tests/run-http-data-interop.py` takes explicit Agent/Gateway
checkouts, a built SQLite binary and an output directory. It runs the real
data path with fixture policy/binding inputs, including 100 warm H1/H2 calls.
`--playwright-module` adds real Chromium/Firefox/WebKit cross-origin calls.
This is separate from standard cold activation and deployed edge acceptance.

## Account sessions and automatic refresh

Existing `createTianaFetch({origin, tianaToken})` callers remain supported. For
account credentials, share one auth provider across every adapter for that login:

```ts
import { createTianaFetch, createTianaSessionAuth } from "@tianacloud/serverless";

const auth = createTianaSessionAuth({
  managementOrigin: "https://console.example.test",
  credentials: {
    accessToken: login.access_token,
    refreshToken: login.refresh_token,
    expiresAt: loginRequestStartedAt + login.expires_in * 1000,
    refreshExpiresAt: Date.parse(login.refresh_expires_at),
    syncStatus: login.sync_status,
  },
  // Optional: atomically replace the complete credential snapshot in your store.
  persist: async credentials => credentialStore.replace(credentials),
});
const tianaFetch = createTianaFetch({ origin: databaseOrigin, auth });
```

`expiresAt` and `refreshExpiresAt` use Unix **milliseconds**. The login response,
store and database origin in this example are supplied by your application; this
package does not initiate login or read environment variables/files. Configure
management routing outside the skill/application (for example pass the process's
`TIANA_API_ORIGIN` when starting a Node host). Only HTTPS management origins are
accepted. The management transport is independent of the data adapter.

Before expiry (30 seconds by default), the provider lazily rotates both tokens
through `POST /api/v1/auth/refresh`. It saves the full replacement, then waits for
`GET /api/v1/auth/transactions/whoami` to report `sync_status: complete`. Omit
`syncStatus` when readiness is unknown; the provider checks it. One provider
shares one refresh/save/readiness operation. Cancelling a caller stops only that
waiter; the shared operation has its own 15-second bound. Synchronization polling
backs off from 250 ms to 2 seconds. Options `refreshBeforeMs`, `timeoutMs` and
`pollIntervalMs` override these defaults. No idle timer refreshes credentials.

The refresh token is sent only to the management refresh endpoint. The access
token becomes the outer Gateway `Authorization` credential, never an inner SQL
credential. Data requests are sent once: a Gateway 401/403, network failure or
truncated response never causes automatic refresh or SQL replay.

`TianaAuthError.code` identifies recovery:

- `AUTH_LOGIN_REQUIRED`: obtain a new login session.
- `AUTH_REFRESH_UNCERTAIN`: the refresh may have committed; do not retry the old
  refresh token. Obtain a new session. Current MGR has no idempotent recovery API.
- `AUTH_PERSIST_FAILED`: retry the provider after repairing the store. The new
  credentials stay in memory, and only persistence is retried. An unresolved save
  is joined, never duplicated. A process crash before a successful atomic save
  can require login again.
- `AUTH_NOT_READY`: no data request was sent. A later call can recheck grant sync.

The concurrency boundary is **one provider**, not all processes/tabs. Use an
external broker/lock when multiple hosts share a rotating refresh token. Account
access tokens have tenant/account data permissions rather than one-instance
scope; run browser application code only within the intended trust boundary.

For browser previews, keep refresh credentials in a broker. CLI `web serve`
provides the compatible `window.tiana.auth` access-token provider:

```ts
const connection = await window.tiana.connection();
const tianaFetch = createTianaFetch({
  origin: connection.origin,
  auth: window.tiana.auth,
  requestBodyMode: "buffered",
});
```

Do not also pass `tianaToken` when using `auth`. The connection's `sql_api` still
selects your SQL client, not the optional `protocol: "tiana-http"` data socket.
Direct browser calls to MGR require an explicitly supported same-origin/CORS
setup; this SDK does not add MGR CORS or persist refresh tokens in browser storage.

Account session providers also accept `onDiagnostic`. Each refresh and whoami
request gets its own request ID before transport starts. The same safe diagnostic
fields are available through `diagnosisOf(error)` for authorization failures,
including when the provider is used by `createTianaFetch`. A cancelled caller
retains its diagnostic without cancelling a refresh shared with other callers.
The callback receives no tokens or response bodies; callback errors do not change
authorization results.

## Files

`createTianaFiles` provides tenant-scoped `list`, `metadata`, `get`, `getUrl`,
`put` and `delete`. File storage shares the tenant's existing storage quota.
Directories are ordinary relative path prefixes. An existing filename requires
an explicit delete or `overwrite: true`, which deletes before uploading; a failed
replacement cannot restore the old file.

In a hosted Tiana WebApp, use the initialized `window.tiana.files` client. Its
server-selected root is the Web ID directory inside the tenant's files. Local
`web serve WEB_ID` uses the same remote directory through a loopback broker.

```js
const files = window.tiana.files;
const page = await files.list("reports/");
const url = await files.getUrl("reports/chart.png");
image.src = url;
// For lazy images which may load after a grant expires:
const unbind = await files.bindImage(image, "reports/chart.png");
const response = await files.get("reports/results.csv");
const text = await response.text();
```

The hosted bootstrap waits for the file cookie before running application code.
`getUrl` also ensures the cookie is ready. Direct `<img>` requests send that
cookie; HTML itself does not renew it. `bindImage` diagnoses a failed load with
HEAD and renews an expired/missing grant once. Missing or damaged files do not
cause a renewal loop.

For Node, supply your existing account auth provider and the management API:

```js
import { createTianaFiles } from "@tianacloud/serverless";

const files = createTianaFiles({
  apiBaseUrl: "https://console.example.test/api/v1/files",
  auth,
});
const page = await files.list("reports/", { cursor: previousCursor });
const file = await files.get("reports/results.csv");
await files.put("notes.txt", new Blob(["hello"], { type: "text/plain" }), {
  onPrepared(upload) { saveUploadId(upload.id); },
});
await files.delete("notes.txt");
```

Each list reads one page. Totals and quota are available from `capabilities()`;
listing does not enumerate every file to calculate usage. `get` returns a Fetch
Response and supports `method: "HEAD"`, `range` and `signal`. `getUrl` returns a
file-origin URL with a public scope selector, never a credential or anonymous
share link. Node should use `get` to send the required Header grant.

Browser integrations outside Bootstrap pass `request(url, init)` for their
existing Cookie/CSRF management broker. This callback must serialize rotating
CSRF mutations and preserve the supplied signal. The SDK's independent `fetch`
handles file-origin Cookie installation/content and OSS multipart uploads.
Do not use the database Fetch adapter as either management or file transport.
Call `clear()` when switching tenant or signing out, then `dispose()` to abort
old work; create a new client for the new session.

Uploads go directly to OSS with an exact-key, exact-size 30-minute form. The
signed multipart file Content-Type is preserved. Writes are never automatically
replayed. Retain the upload ID from `onPrepared`; `uploadStatus`, `completeUpload`
and `cancelUpload` address that same operation. Cancelling does not revoke an
already-issued OSS form or immediately release its reservation. A lost complete
response raises `FILE_COMPLETE_UNCERTAIN` with `uploadId`; query the operation
before starting another upload. MGR's expiry check settles uploads even if the
browser closes. Browser `onProgress` uses XHR; Node reports transfer completion.
