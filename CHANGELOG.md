# Changelog

## 0.2.0 — 2026-10-27

- Add unified one-shot device location through `createTianaLocation`, with public result, options and error types. Browser Geolocation and mobile WeChat/WebView return WGS-84 through the same API.
- Include a lazy, same-origin WeChat browser asset with isolated SDK state, bounded setup, cancellation and teardown. Platform signing selects the server-configured AppID.
- Expose buffered Fetch v1 frame codecs through the public `@tianacloud/serverless/codec` entry point.
- Preserve existing Fetch, authentication and file APIs and transport semantics. Device permissions and real-phone location require host integration and device acceptance.
