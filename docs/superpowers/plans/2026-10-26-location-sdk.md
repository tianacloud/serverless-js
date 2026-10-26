# Unified Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 应用通过tiana.location统一单次定位，AppID由服务端固定。
**Architecture:** SDK拥有能力检测、微信加载签名与结果归一；Web/CLI注入SDK工厂，应用只调用公共接口。复用既有后端签名，不改数据面/密钥配置。
**Tech Stack:** TypeScript、ES modules、Go embed、Node/Chrome tests。
**Spec:** docs/superpowers/specs/2026-10-26-location-design.md

## Global Constraints
WGS-84、单次、无位置存储/上传；无具体AppID常量；微信脚本/签名按需加载；保留原SDK跨运行时兼容。后续授权仅将SDK提交并推送到main；不进行npm发布或平台部署。

## Review Focus
取消等待不能晚调用定位；并发取消隔离；失败SDK旧ready状态；数字字符串误判/空值转0；预览授权和同源资源边界。

### Task 1: SDK capability
Files: src/location.ts, src/index.ts, scripts/copy-browser-assets.mjs, vendor/jweixin-1.6.0.js, tests/location.test.mjs, tests/types/location.ts, README.md, AGENTS.md.
Interfaces: createTianaLocation(options): TianaLocation; getCurrentPosition({timeoutMs?,signal?}): Promise<TianaPosition>; dispose():void.
- [x] Write failing tests for browser/WeChat numeric normalization, permission, bounded timeout/abort, concurrent setup and cancellation, SDK retry, no eager access/network and unsupported Node.
- [x] Run RED, implement capability and exports/resources, run complete SDK tests/types/browser and packaging.

### Task 2: Platform injection
Files: Web cmd/tiana-web/bootstrap-runtime/{bootstrap.js,sdk/location.js,sdk/jweixin.js}, apps.go, location_browser_test.go; CLI internal/appbootstrap/runtime same files, server.go, location tests; both README/AGENTS.
Interfaces: factory receives platform same-origin signingUrl/sdkUrl/entryUrl; context.location provides Task1 API.
- [x] Write Go route/browser tests proving location exists without DB, safe lazy resources, authenticated preview route behavior, unconfigured local WeChat configuration error.
- [x] Run RED; embed built SDK resources, inject factory before app import, dispose on pagehide. Keep bootstrap copies identical and prove through real Chrome fixture.
- [x] Run relevant then full Go race/vet/build and source policy checks, preserve existing auth/files.

### Task 3: App migration and integration
Files: location-app/src/{app.js,location.mjs}, tests and README/build configuration; local fixture bootstrap.
Interfaces: app consumes only window.tiana.location.getCurrentPosition and AbortController.
- [x] Add failing UI fixture using real built SDK injected as platform; no app UA/wx/signing logic. Maintain same UI/cancellation/refresh behavior.
- [x] Implement migration; run logical and actual Chrome integration tests including browser and official WeChat SDK bridge.
- [x] Independently review all changes, address important findings with RED→GREEN, record baselines/branches/tests/remaining live acceptance. User subsequently authorized SDK commit and push to main; preserve other reviewable work copies without publishing.
