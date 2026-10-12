import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTianaFetch,
  createTianaSessionAuth,
  diagnosisOf,
} from "../dist/index.js";

const managementOrigin = "https://console.example.test";
const origin =
  "https://ep-7k3rbz6104qg3qk2z6de5z2vmh.db.service.internal.tiana.com";
const json = (body, status = 200) => Response.json(body, { status });
const credentials = (extra = {}) => ({
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Date.now() + 3600000,
  refreshExpiresAt: Date.now() + 86400000,
  syncStatus: "complete",
  ...extra,
});
const replacement = (extra = {}) => ({
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 3600,
  refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
  token_type: "Bearer",
  sync_status: "complete",
  ...extra,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const code = (expected) => (error) => error.code === expected;

test("valid account access has no management calls; credentials are snapshotted", async () => {
  const input = credentials();
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: input,
    fetch: () => assert.fail("unexpected fetch"),
  });
  input.accessToken = "changed";
  assert.equal(await auth.getAccessToken(), "old-access");
});

test("one shared rotation, atomic replacement saved before access, cancelled waiter independent", async () => {
  const gate = deferred();
  let calls = 0,
    saved = 0;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, managementOrigin + "/api/v1/auth/refresh");
      assert.deepEqual(JSON.parse(init.body), { refresh_token: "old-refresh" });
      assert.equal(init.headers.authorization, undefined);
      assert.equal(init.redirect, "error");
      await gate.promise;
      return json(replacement());
    },
    persist: async (value) => {
      saved++;
      assert.equal(value.refreshToken, "new-refresh");
      assert.equal(value.accessToken, "new-access");
      assert.ok(Object.isFrozen(value));
    },
  });
  const controller = new AbortController();
  const cancelled = auth.getAccessToken({ signal: controller.signal });
  const rest = Array.from({ length: 20 }, () => auth.getAccessToken());
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  gate.resolve();
  assert.deepEqual(await Promise.all(rest), Array(20).fill("new-access"));
  assert.equal(calls, 1);
  assert.equal(saved, 1);
});

test("pending synchronization gates data without rotating twice", async () => {
  const paths = [];
  let polls = 0;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    pollIntervalMs: 1,
    fetch: async (url, init) => {
      paths.push(url);
      if (url.endsWith("/refresh"))
        return json(replacement({ sync_status: "pending" }));
      assert.equal(init.headers.authorization, "Bearer new-access");
      assert.equal(init.body, undefined);
      return json({ sync_status: ++polls === 1 ? "pending" : "complete" });
    },
  });
  assert.equal(await auth.getAccessToken(), "new-access");
  assert.equal(paths.filter((p) => p.endsWith("/refresh")).length, 1);
  assert.equal(polls, 2);
});

test("initial credentials of unknown readiness are checked", async () => {
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ syncStatus: undefined }),
    fetch: async (url) => {
      assert.ok(url.endsWith("/whoami"));
      return json({ sync_status: "complete" });
    },
  });
  assert.equal(await auth.getAccessToken(), "old-access");
});

test("failed save retains replacement and retries only persistence", async () => {
  let calls = 0,
    saves = 0;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    fetch: async () => {
      calls++;
      return json(replacement());
    },
    persist: async (value) => {
      assert.equal(value.refreshToken, "new-refresh");
      if (++saves === 1) throw Error("secret");
    },
  });
  await assert.rejects(auth.getAccessToken(), code("AUTH_PERSIST_FAILED"));
  assert.equal(await auth.getAccessToken(), "new-access");
  assert.equal(calls, 1);
  assert.equal(saves, 2);
});

test("hanging persistence is bounded and shared across subsequent calls", async () => {
  const gate = deferred();
  let saves = 0,
    refreshes = 0;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    timeoutMs: 15,
    fetch: async () => {
      refreshes++;
      return json(replacement());
    },
    persist: () => {
      saves++;
      return gate.promise;
    },
  });
  await assert.rejects(auth.getAccessToken(), code("AUTH_PERSIST_FAILED"));
  await assert.rejects(auth.getAccessToken(), code("AUTH_PERSIST_FAILED"));
  assert.equal(saves, 1);
  gate.resolve();
  assert.equal(await auth.getAccessToken(), "new-access");
  assert.equal(refreshes, 1);
});

for (const [name, fetch, expected] of [
  [
    "lost response",
    async () => {
      throw Error("secret response");
    },
    "AUTH_REFRESH_UNCERTAIN",
  ],
  [
    "commit unknown",
    async () => json({ error: "commit_status_unknown" }, 503),
    "AUTH_REFRESH_UNCERTAIN",
  ],
  [
    "malformed success",
    async () => json({ access_token: "secret" }),
    "AUTH_REFRESH_UNCERTAIN",
  ],
  [
    "invalid grant",
    async () => json({ error: "invalid_grant" }, 400),
    "AUTH_LOGIN_REQUIRED",
  ],
])
  test(name + " latches without replay or token disclosure", async () => {
    let calls = 0;
    const auth = createTianaSessionAuth({
      managementOrigin,
      credentials: credentials({ expiresAt: 1 }),
      fetch: (...args) => {
        calls++;
        return fetch(...args);
      },
    });
    for (let i = 0; i < 2; i++)
      await assert.rejects(auth.getAccessToken(), (error) => {
        assert.equal(error.code, expected);
        assert.doesNotMatch(error.message, /secret|old-refresh/);
        return true;
      });
    assert.equal(calls, 1);
  });

test("hung refresh times out and is not repeated", async () => {
  let calls = 0;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    timeoutMs: 10,
    fetch: () => {
      calls++;
      return new Promise(() => {});
    },
  });
  await assert.rejects(auth.getAccessToken(), code("AUTH_REFRESH_UNCERTAIN"));
  await assert.rejects(auth.getAccessToken(), code("AUTH_REFRESH_UNCERTAIN"));
  assert.equal(calls, 1);
});

test("readiness timeout retries synchronization using replacement", async () => {
  let ready = false,
    refreshes = 0;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    timeoutMs: 15,
    pollIntervalMs: 1,
    fetch: async (url) => {
      if (url.endsWith("/refresh")) {
        refreshes++;
        return json(replacement({ sync_status: "pending" }));
      }
      return json({ sync_status: ready ? "complete" : "pending" });
    },
  });
  await assert.rejects(auth.getAccessToken(), code("AUTH_NOT_READY"));
  ready = true;
  assert.equal(await auth.getAccessToken(), "new-access");
  assert.equal(refreshes, 1);
});

test("expired refresh requires login before any network call", async () => {
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1, refreshExpiresAt: 1 }),
    fetch: () => assert.fail("network"),
  });
  await assert.rejects(auth.getAccessToken(), code("AUTH_LOGIN_REQUIRED"));
});

test("provider rejected or caller cancelled never sends a data request", async () => {
  const controller = new AbortController();
  const transport = createTianaFetch({
    origin,
    auth: { getAccessToken: () => new Promise(() => {}) },
    fetch: () => assert.fail("data"),
  });
  const result = transport(origin + "/v3/pipeline", {
    method: "POST",
    body: "write",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  const denied = createTianaFetch({
    origin,
    auth: {
      getAccessToken: async () => {
        throw Error("login required");
      },
    },
    fetch: () => assert.fail("data"),
  });
  await assert.rejects(denied(origin), /login required/);
});

test("outer auth failures do not refresh or replay SQL writes", async () => {
  let tokens = 0,
    data = 0;
  const transport = createTianaFetch({
    origin,
    auth: {
      getAccessToken: async () => {
        tokens++;
        return "account-access";
      },
    },
    fetch: async (_url, init) => {
      data++;
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer account-access",
      );
      return new Response(null, { status: 403 });
    },
  });
  await assert.rejects(
    transport(origin + "/v3/pipeline", { method: "POST", body: "write" }),
  );
  assert.equal(tokens, 1);
  assert.equal(data, 1);
});

test("exactly one auth source and HTTPS management origin are required", () => {
  assert.throws(
    () =>
      createTianaFetch({
        origin,
        tianaToken: "static",
        auth: { getAccessToken: async () => "" },
      }),
    TypeError,
  );
  for (const managementOrigin of [
    "http://console.example.test",
    "https://user:secret@console.example.test",
    "https://console.example.test/path",
  ])
    assert.throws(
      () =>
        createTianaSessionAuth({
          managementOrigin,
          credentials: credentials(),
        }),
      TypeError,
    );
});

test("oversized refresh response is bounded and cannot be retried", async () => {
  let calls = 0;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    fetch: async () => {
      calls++;
      return new Response("x".repeat(65537));
    },
  });
  await assert.rejects(auth.getAccessToken(), code("AUTH_REFRESH_UNCERTAIN"));
  await assert.rejects(auth.getAccessToken(), code("AUTH_REFRESH_UNCERTAIN"));
  assert.equal(calls, 1);
});

test("failed synchronization can be checked after the manager repairs the grant", async () => {
  let ready = false;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ syncStatus: "failed" }),
    fetch: async (url) => {
      assert.ok(url.endsWith("/whoami"));
      return json({ sync_status: ready ? "complete" : "failed" });
    },
  });
  await assert.rejects(auth.getAccessToken(), code("AUTH_NOT_READY"));
  ready = true;
  assert.equal(await auth.getAccessToken(), "old-access");
});

test("management refresh and readiness diagnostics retain each request ID", async () => {
  const events = [],
    ids = [];
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    onDiagnostic(event) {
      events.push(event);
      throw new Error("observer failure");
    },
    fetch: async (url, init) => {
      ids.push(new Headers(init.headers).get("x-request-id"));
      return url.endsWith("/refresh")
        ? json(replacement({ sync_status: "pending" }))
        : json({ sync_status: "complete" });
    },
  });
  assert.equal(await auth.getAccessToken(), "new-access");
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => /^req-/.test(id)));
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids)
    assert.deepEqual(
      events.filter((e) => e.requestId === id).map((e) => e.phase),
      ["request_started", "response_started", "completed"],
    );
  assert.ok(!JSON.stringify(events).includes("old-refresh"));
});
for (const mode of ["network", "malformed", "rejected", "timeout", "whoami"]) {
  test("management diagnostic failure: " + mode, async () => {
    const events = [];
    let sentID,
      calls = 0;
    const auth = createTianaSessionAuth({
      managementOrigin,
      credentials: credentials(
        mode === "whoami" ? { syncStatus: "pending" } : { expiresAt: 1 },
      ),
      timeoutMs: 10,
      onDiagnostic: (e) => events.push(e),
      fetch: async (_url, init) => {
        calls++;
        sentID = new Headers(init.headers).get("x-request-id");
        if (mode === "network") throw new Error("secret-response-never-expose");
        if (mode === "timeout") return new Promise(() => {});
        if (mode === "malformed") return new Response("invalid-json");
        return json({}, 401);
      },
    });
    let failure;
    try {
      await auth.getAccessToken();
    } catch (e) {
      failure = e;
    }
    assert.ok(sentID);
    assert.equal(diagnosisOf(failure)?.requestId, sentID);
    assert.ok(["failed", "cancelled"].includes(diagnosisOf(failure)?.phase));
    assert.ok(!JSON.stringify(events).includes("secret-response-never-expose"));
    if (mode !== "whoami") {
      await assert.rejects(auth.getAccessToken());
      assert.equal(calls, 1);
    }
  });
}
test("cancelled auth waiter keeps request identity without cancelling shared refresh", async () => {
  const gate = deferred(),
    entered = deferred(),
    events = [];
  let id;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    onDiagnostic: (e) => events.push(e),
    fetch: async (_url, init) => {
      id = new Headers(init.headers).get("x-request-id");
      entered.resolve();
      await gate.promise;
      return json(replacement());
    },
  });
  const controller = new AbortController();
  const pending = auth.getAccessToken({ signal: controller.signal });
  const other = auth.getAccessToken();
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, (e) => {
    assert.equal(diagnosisOf(e)?.requestId, id);
    assert.equal(diagnosisOf(e)?.phase, "cancelled");
    return true;
  });
  gate.resolve();
  assert.equal(await other, "new-access");
  assert.equal(events.at(-1).phase, "completed");
});

test("adapter preserves the failed management request diagnostic", async () => {
  let managementID;
  const auth = createTianaSessionAuth({
    managementOrigin,
    credentials: credentials({ expiresAt: 1 }),
    fetch: async (_url, init) => {
      managementID = new Headers(init.headers).get("x-request-id");
      return json({}, 401);
    },
  });
  const transport = createTianaFetch({
    origin,
    auth,
    fetch: () => assert.fail("unexpected Gateway request"),
  });
  const request = new Request(origin + "/v2/pipeline", {
    method: "POST",
    body: "{}",
  });
  await assert.rejects(transport(request), (error) => {
    assert.equal(diagnosisOf(error)?.requestId, managementID);
    assert.notEqual(diagnosisOf(request)?.requestId, managementID);
    assert.equal(diagnosisOf(request)?.phase, "failed");
    return true;
  });
});
