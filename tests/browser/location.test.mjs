import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
let server, browser, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (
      url.pathname === "/sdk/location.js" ||
      url.pathname === "/sdk/jweixin.js"
    ) {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        await readFile(
          new URL(
            "../../dist/" + url.pathname.split("/").pop(),
            import.meta.url,
          ),
        ),
      );
      return;
    }
    if (url.pathname === "/sign") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          app_id: "wxabcdef0123456789",
          timestamp: 1793000000,
          nonce_str: "nonce",
          signature: "a".repeat(40),
          url: url.searchParams.get("url"),
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<script type="module">import{createTianaLocation}from'/sdk/location.js';window.tiana={location:createTianaLocation({entryUrl:location.href,signingUrl:new URL('/sign',location.href).href,sdkUrl:new URL('/sdk/jweixin.js',location.href).href})};</script>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});
async function wechat() {
  const context = await browser.newContext({
    userAgent: "Android Mobile MicroMessenger/8.0.1",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.verifies = [];
    window.geoCalls = 0;
    window.locationListeners = new Set();
    const add = document.addEventListener.bind(document),
      remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, options) => {
      if (type === "error" || type === "load")
        window.locationListeners.add(listener);
      return add(type, listener, options);
    };
    document.removeEventListener = (type, listener, options) => {
      window.locationListeners.delete(listener);
      return remove(type, listener, options);
    };
    window.originalWx = { miniProgram: { navigateTo() {} } };
    window.originalAlias = { existing: true };
    window.wx = window.originalWx;
    window.jWeixin = window.originalAlias;
    window.WeixinJSBridge = {
      on() {},
      invoke(name, params, callback) {
        if (name === "preVerifyJSAPI") window.verifies.push(callback);
        if (name === "geoLocation") {
          window.geoCalls++;
          window.locationType = params.type;
          callback({
            err_msg: "geoLocation:ok",
            latitude: "31.23",
            longitude: "121.47",
            accuracy: "9",
          });
        }
      },
    };
  });
  await page.goto(origin + "/?a=%2f&x=1&x=2#ignored");
  await page.waitForFunction(() => window.tiana);
  return { context, page };
}
test("real browser uses hardware API and never loads WeChat resources", async () => {
  const context = await browser.newContext({
    geolocation: { latitude: 31.23, longitude: 121.47, accuracy: 9 },
    permissions: ["geolocation"],
  });
  try {
    const page = await context.newPage(),
      requests = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto(origin);
    await page.waitForFunction(() => window.tiana);
    const p = await page.evaluate(() =>
      window.tiana.location.getCurrentPosition(),
    );
    assert.equal(p.latitude, 31.23);
    assert.equal(p.coordinateSystem, "WGS-84");
    assert.equal(
      requests.some((r) => r.includes("/sign") || r.includes("jweixin")),
      false,
    );
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
  } finally {
    await context.close();
  }
});
test("official WeChat SDK waits for preVerify and normalizes native numeric strings", async () => {
  const { context, page } = await wechat();
  try {
    const requests = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.evaluate(() => {
      window.result = window.tiana.location.getCurrentPosition();
    });
    await page.waitForFunction(() => window.verifies.length === 1);
    assert.equal(await page.evaluate(() => window.geoCalls), 0);
    await page.evaluate(() =>
      window.verifies[0]({ err_msg: "preVerifyJSAPI:ok" }),
    );
    const p = await page.evaluate(() => window.result);
    assert.equal(p.longitude, 121.47);
    assert.equal(p.accuracy, 9);
    assert.equal(p.coordinateSystem, "WGS-84");
    assert.equal(await page.evaluate(() => window.locationType), "wgs84");
    assert.equal(
      await page.evaluate(
        () =>
          window.wx === window.originalWx &&
          window.jWeixin === window.originalAlias,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(() => {
        window.tiana.location.dispose();
        return window.locationListeners.size;
      }),
      0,
    );

    const sign = new URL(requests.find((r) => r.includes("/sign")));
    assert.equal(sign.searchParams.get("url"), origin + "/?a=%2f&x=1&x=2");
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
  } finally {
    await context.close();
  }
});
test("failed official SDK configuration reloads its private ready state before retry", async () => {
  const { context, page } = await wechat();
  try {
    await page.evaluate(() => {
      window.result = window.tiana.location
        .getCurrentPosition()
        .catch((e) => ({ code: e.code, diagnostic: e.diagnostic }));
    });
    await page.waitForFunction(() => window.verifies.length === 1);
    await page.evaluate(() => {
      window.verifies[0]({ err_msg: "preVerifyJSAPI:fail invalid signature" });
    });
    assert.equal(
      (await page.evaluate(() => window.result)).diagnostic,
      "WX_SIGNATURE_INVALID",
    );
    await page.evaluate(() => {
      window.result = window.tiana.location.getCurrentPosition();
    });
    await page.waitForFunction(() => window.verifies.length === 2);
    assert.equal(await page.evaluate(() => window.geoCalls), 0);
    assert.equal(
      await page.evaluate(
        () =>
          window.wx === window.originalWx &&
          window.jWeixin === window.originalAlias,
      ),
      true,
    );
    await page.evaluate(() =>
      window.verifies[1]({ err_msg: "preVerifyJSAPI:ok" }),
    );
    assert.equal((await page.evaluate(() => window.result)).latitude, 31.23);
  } finally {
    await context.close();
  }
});
test("abort before official ready never starts the native location call", async () => {
  const { context, page } = await wechat();
  try {
    await page.evaluate(() => {
      window.abortLocation = new AbortController();
      window.result = window.tiana.location
        .getCurrentPosition({ signal: window.abortLocation.signal })
        .catch((e) => e.code);
    });
    await page.waitForFunction(() => window.verifies.length === 1);
    await page.evaluate(() => window.abortLocation.abort());
    assert.equal(await page.evaluate(() => window.result), "ABORTED");
    await page.evaluate(() =>
      window.verifies[0]({ err_msg: "preVerifyJSAPI:ok" }),
    );
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => window.geoCalls), 0);
  } finally {
    await context.close();
  }
});
