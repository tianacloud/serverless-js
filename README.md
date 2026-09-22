# `@tiana/serverless`

`@tiana/serverless` is the JavaScript/TypeScript Custom Fetch adapter for
Tiana Fetch-over-HTTPS v1. It converts one standard same-origin `fetch()`
request into a TFQ1 request to the Tiana Gateway and exposes the TFS1 inner
response as a standard `Response`.

The initial package is private and unreleased. Its historical Fetch v1 compatibility baseline is
Contracts release `v0.17.2-rc.1` at commit
`d252fd7bf689657e50b6caf36298f8c57860df6b` (annotated tag object
`fb4fdf07f6e5b86eb00562f07dccf7bd120cd0f2`).

## Intended use

```ts
import { createTianaFetch } from "@tiana/serverless";

const databaseOrigin =
  "https://ep-01j5c9m7q2v8x4k6n3r0t1w2yz.db.service.internal.tiana.com";

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

The configured origin is restricted to the frozen v1 public authority:
`ep-[0-7][0-9a-hjkmnp-tv-z]{25}.db.service.internal.tiana.com` with HTTPS
on the deployment port (443 by default). Arbitrary hosts, IP literals, localhost, paths,
queries, fragments, and embedded credentials are rejected before transport.

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

## Development

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

The runtime has no production dependencies and uses only standard Fetch,
Web Streams, URL, Encoding, and Web Crypto APIs. Node and Bun have local test coverage. Deno must be reported as unverified when it is not installed; a
different runtime must never be inferred from TypeScript compilation alone.

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
