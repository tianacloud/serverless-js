import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../dist/index.js";
const entry = "https://app.example.test/web/demo/?a=%2f&x=1&x=2";
const config = {
  app_id: "wx0123456789abcdef",
  timestamp: 1793000000,
  nonce_str: "nonce",
  signature: "a".repeat(40),
  url: entry,
};
const options = {
  entryUrl: entry + "#ignored",
  signingUrl: "https://app.example.test/web/demo/_tiana/wechat-config",
  sdkUrl: "https://app.example.test/web/demo/_tiana/sdk/jweixin.js",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function browser(
  t,
  {
    wechat = false,
    desktop = false,
    silent = false,
    rejectConfig = false,
  } = {},
) {
  const old = globalThis.window,
    geo = [],
    native = [],
    configs = [],
    scripts = [],
    requests = [];
  let ready, error;
  const view = {
    location: new URL(entry),
    navigator: {
      userAgent: wechat
        ? desktop
          ? "Windows NT WindowsWechat MicroMessenger/8.0"
          : "Android Mobile MicroMessenger/8.0"
        : "Mozilla browser",
      geolocation: {
        getCurrentPosition(...args) {
          geo.push(args);
        },
      },
    },
    document: {
      createElement: () => ({ remove() {} }),
      head: {
        append(script) {
          scripts.push(script);
          const api = {
            ready(fn) {
              ready = fn;
            },
            error(fn) {
              error = fn;
            },
            config(value) {
              configs.push(value);
              queueMicrotask(() =>
                rejectConfig
                  ? error({ errMsg: "config:invalid signature private" })
                  : ready(),
              );
            },
            getLocation(value) {
              native.push(value);
              if (!silent)
                value.success({
                  latitude: "31.23",
                  longitude: "121.47",
                  accuracy: "9",
                });
            },
          };
          view.__tianaLocationCreateWechatSDK = () => ({ api, dispose() {} });
          queueMicrotask(() => script.onload?.());
        },
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    value: view,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (old === undefined) delete globalThis.window;
    else globalThis.window = old;
  });
  return {
    view,
    geo,
    native,
    configs,
    scripts,
    requests,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(config);
    },
  };
}
function create(t, env, extra = {}) {
  assert.equal(typeof sdk.createTianaLocation, "function");
  const location = sdk.createTianaLocation({
    ...options,
    fetch: env.fetch,
    ...extra,
  });
  t.after(() => location.dispose());
  return location;
}
test("location exports import in a nonbrowser runtime without network or globals", async () => {
  assert.equal(typeof sdk.createTianaLocation, "function");
  const location = sdk.createTianaLocation();
  await assert.rejects(
    location.getCurrentPosition(),
    (e) => e.code === "UNSUPPORTED",
  );
  location.dispose();
});
test("ordinary browser requests one fresh WGS84 value only on explicit call", async (t) => {
  const env = browser(t),
    location = create(t, env);
  assert.equal(env.geo.length + env.requests.length + env.scripts.length, 0);
  const pending = location.getCurrentPosition();
  await tick();
  assert.equal(env.geo.length, 1);
  assert.equal(env.geo[0][2].maximumAge, 0);
  env.geo[0][0]({
    coords: { latitude: 31.23, longitude: 121.47, accuracy: 9 },
    timestamp: Date.now(),
  });
  const p = await pending;
  assert.equal(p.latitude, 31.23);
  assert.equal(p.coordinateSystem, "WGS-84");
  assert.equal(env.requests.length, 0);
});
test("WeChat uses platform signed config without a hardcoded AppID and normalizes decimals", async (t) => {
  const env = browser(t, { wechat: true }),
    location = create(t, env);
  assert.equal(env.scripts.length, 0);
  const p = await location.getCurrentPosition();
  assert.equal(p.longitude, 121.47);
  assert.equal(p.accuracy, 9);
  assert.equal(p.coordinateSystem, "WGS-84");
  assert.equal(env.configs[0].appId, "wx0123456789abcdef");
  assert.deepEqual(env.configs[0].jsApiList, ["getLocation"]);
  assert.equal(env.native[0].type, "wgs84");
  assert.equal(env.geo.length, 0);
  assert.equal(new URL(env.requests[0].url).searchParams.get("url"), entry);
  assert.equal(new URL(env.requests[0].url).searchParams.has("app_id"), false);
  assert.equal(env.requests[0].init.credentials, "same-origin");
});
test("desktop WeChat uses available browser location without mobile SDK work", async (t) => {
  const env = browser(t, { wechat: true, desktop: true }),
    location = create(t, env),
    pending = location.getCurrentPosition();
  await tick();
  env.geo[0][0]({
    coords: { latitude: 0, longitude: 0, accuracy: 1 },
    timestamp: Date.now(),
  });
  assert.equal((await pending).latitude, 0);
  assert.equal(env.scripts.length, 0);
});
test("caller abort while configuration is loading never invokes late location", async (t) => {
  const env = browser(t, { wechat: true });
  let release;
  env.fetch = () =>
    new Promise((resolve) => {
      release = () => resolve(Response.json(config));
    });
  const location = create(t, env),
    abort = new AbortController(),
    pending = location.getCurrentPosition({ signal: abort.signal });
  const rejected = assert.rejects(pending, (e) => e.code === "ABORTED");
  await tick();
  abort.abort("private");
  await rejected;
  release();
  await tick();
  assert.equal(env.native.length, 0);
});
test("shared configuration has independent cancelled and active waiters", async (t) => {
  const env = browser(t, { wechat: true }),
    location = create(t, env),
    abort = new AbortController();
  const first = location.getCurrentPosition({ signal: abort.signal }),
    rejected = assert.rejects(first, (e) => e.code === "ABORTED");
  const second = location.getCurrentPosition();
  abort.abort();
  await rejected;
  assert.equal((await second).accuracy, 9);
  assert.equal(env.requests.length, 1);
  assert.equal(env.native.length, 1);
});
test("browser permission rejection is stable and does not leak native strings", async (t) => {
  const env = browser(t),
    location = create(t, env),
    pending = location.getCurrentPosition();
  await tick();
  env.geo[0][1]({ code: 1, message: "private" });
  await assert.rejects(
    pending,
    (e) => e.code === "PERMISSION_DENIED" && !e.message.includes("private"),
  );
});
test("configuration rejection uses bounded diagnostics and reloads SDK before retry", async (t) => {
  const env = browser(t, { wechat: true, rejectConfig: true }),
    location = create(t, env);
  await assert.rejects(
    location.getCurrentPosition(),
    (e) =>
      e.code === "CONFIGURATION" &&
      e.diagnostic === "WX_SIGNATURE_INVALID" &&
      !e.message.includes("private"),
  );
  await assert.rejects(location.getCurrentPosition());
  assert.equal(env.scripts.length, 2);
  assert.notEqual(env.scripts[0].src, env.scripts[1].src);
  assert.equal(env.native.length, 0);
});
test("invalid numeric fields remain rejected without exposing values", async (t) => {
  const env = browser(t, { wechat: true, silent: true }),
    location = create(t, env),
    pending = location.getCurrentPosition();
  await tick();
  env.native[0].success({ latitude: "", longitude: "121.47", accuracy: "9" });
  await assert.rejects(
    pending,
    (e) =>
      e.code === "INVALID_RESULT" && e.diagnostic === "RESULT_LATITUDE_INVALID",
  );
});
test("total timeout and dispose ignore delayed browser success", async (t) => {
  const env = browser(t),
    location = create(t, env);
  const pending = location.getCurrentPosition({ timeoutMs: 5 });
  await assert.rejects(pending, (e) => e.code === "TIMEOUT");
  env.geo[0][0]({
    coords: { latitude: 1, longitude: 1, accuracy: 1 },
    timestamp: Date.now(),
  });
  const second = location.getCurrentPosition();
  location.dispose();
  await assert.rejects(second, (e) => e.code === "DISPOSED");
  await assert.rejects(
    location.getCurrentPosition(),
    (e) => e.code === "DISPOSED",
  );
});
test("invalid options and foreign configuration origins fail before transport", async (t) => {
  const env = browser(t, { wechat: true }),
    location = create(t, env, {
      signingUrl: "https://foreign.example.test/sign",
    });
  await assert.rejects(
    location.getCurrentPosition(),
    (e) => e.code === "CONFIGURATION",
  );
  assert.equal(env.requests.length, 0);
  await assert.rejects(
    location.getCurrentPosition({ timeoutMs: Infinity }),
    TypeError,
  );
});
test("disposing during SDK ready wait releases setup timers and lets a Node host exit", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = `import {createTianaLocation} from ${JSON.stringify(new URL("../dist/location.js", import.meta.url).href)};
 let ready=false;
 globalThis.window={location:new URL('https://app.example.test/'),navigator:{userAgent:'Android MicroMessenger'},document:{createElement:()=>({remove(){}}),head:{append(script){window.__tianaLocationCreateWechatSDK=()=>({api:{config(){},ready(){ready=true},error(){},getLocation(){throw Error('late location')}},dispose(){}});queueMicrotask(()=>script.onload())}}}};
 const location=createTianaLocation({signingUrl:'https://app.example.test/sign',sdkUrl:'https://app.example.test/sdk.js',fetch:async()=>Response.json({app_id:'wx0123456789abcdef',timestamp:1793000000,nonce_str:'n',signature:'a'.repeat(40),url:'https://app.example.test/'})});
 const request=location.getCurrentPosition().catch(e=>{if(e.code!=='DISPOSED')throw e});await new Promise(setImmediate);if(!ready)throw Error('did not reach ready wait');location.dispose();await request;`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 2000,
  });
});
test("bounded setup failure releases every waiter and permits retry", async (t) => {
  const env = browser(t, { wechat: true });
  env.view.document.head.append = () => {};
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const location = create(t, env);
  const pending = location.getCurrentPosition(),
    rejected = assert.rejects(
      pending,
      (e) => e.code === "CONFIGURATION" && e.diagnostic === "WX_SETUP_TIMEOUT",
    );
  await tick();
  t.mock.timers.tick(10000);
  await rejected;
});
test("concurrent caller bound and pre-aborted signals perform no extra device work", async (t) => {
  const env = browser(t),
    location = create(t, env),
    abort = new AbortController();
  abort.abort();
  await assert.rejects(
    location.getCurrentPosition({ signal: abort.signal }),
    (e) => e.code === "ABORTED",
  );
  assert.equal(env.geo.length, 0);
  const pending = Array.from({ length: 32 }, () =>
    location.getCurrentPosition().catch((e) => e.code),
  );
  await assert.rejects(location.getCurrentPosition(), (e) => e.code === "BUSY");
  location.dispose();
  assert.deepEqual(await Promise.all(pending), Array(32).fill("DISPOSED"));
});
test("a server host with a window shim remains unsupported without DOM access", async (t) => {
  const old = globalThis.window;
  globalThis.window = { navigator: { userAgent: "Deno" } };
  t.after(() => {
    if (old === undefined) delete globalThis.window;
    else globalThis.window = old;
  });
  const location = sdk.createTianaLocation();
  await assert.rejects(
    location.getCurrentPosition(),
    (e) => e.code === "UNSUPPORTED",
  );
  location.dispose();
});
test("a failed location script cannot remove existing WeChat navigation globals", async (t) => {
  const env = browser(t, { wechat: true }),
    existing = { miniProgram: { navigateTo() {} } },
    alias = { existing: true };
  env.view.wx = existing;
  env.view.jWeixin = alias;
  env.view.document.head.append = (script) =>
    queueMicrotask(() => script.onerror());
  const location = create(t, env);
  await assert.rejects(
    location.getCurrentPosition(),
    (e) => e.code === "CONFIGURATION",
  );
  assert.equal(env.view.wx, existing);
  assert.equal(env.view.jWeixin, alias);
});
test("a retried resource without a new private factory cannot reuse a stale SDK", async (t) => {
  const env = browser(t, { wechat: true, rejectConfig: true }),
    location = create(t, env);
  await assert.rejects(location.getCurrentPosition());
  env.view.document.head.append = (script) =>
    queueMicrotask(() => script.onload());
  await assert.rejects(
    location.getCurrentPosition(),
    (e) => e.diagnostic === "WX_SDK_LOAD_FAILED",
  );
  assert.equal(env.requests.length, 1);
});
