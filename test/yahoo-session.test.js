/**
 * Unit tests for Yahoo cookie/crumb session helpers and Worker injection.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { pathToFileURL } from "node:url";

const sessionMod = await import(
  pathToFileURL(new URL("../src/yahoo-session.js", import.meta.url).pathname).href
);
const workerMod = await import(
  pathToFileURL(new URL("../src/index.js", import.meta.url).pathname).href
);
const worker = workerMod.default;

function req(path, init = {}) {
  return new Request(`https://proxy.example${path}`, init);
}

describe("yahoo-session helpers", () => {
  beforeEach(() => {
    sessionMod.resetYahooSession();
  });

  it("merges cookie headers preferring later values", () => {
    const out = sessionMod.mergeCookieHeader("A3=old; B=1", "A3=new", "C=3");
    assert.equal(out.includes("A3=new"), true);
    assert.equal(out.includes("A3=old"), false);
    assert.equal(out.includes("B=1"), true);
    assert.equal(out.includes("C=3"), true);
  });

  it("injects crumb for options but not fc bootstrap", () => {
    assert.equal(
      sessionMod.shouldInjectCrumb(new URL("https://query1.finance.yahoo.com/v7/finance/options/SPY")),
      true,
    );
    assert.equal(
      sessionMod.shouldInjectCrumb(new URL("https://fc.yahoo.com/")),
      false,
    );
    assert.equal(
      sessionMod.shouldInjectCrumb(new URL("https://query1.finance.yahoo.com/v1/test/getcrumb")),
      false,
    );
  });

  it("bootstraps cookie only after getcrumb retries are exhausted on 429", async () => {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: {
            "set-cookie":
              "A3=tok429; Domain=.yahoo.com; Path=/; SameSite=None; Secure; HttpOnly",
          },
        });
      }
      if (u.includes("getcrumb")) {
        return new Response("Too Many Requests", { status: 429 });
      }
      throw new Error(`unexpected fetch ${u}`);
    };
    try {
      const s = await sessionMod.ensureYahooSession({
        force: true,
        getcrumbRetryDelaysMs: [0, 0],
      });
      assert.equal(s.cookie, "A3=tok429");
      assert.equal(s.crumb, null);
      assert.equal(calls.length, 4);
      assert.equal(calls.filter((u) => u.includes("getcrumb")).length, 3);
      const again = await sessionMod.ensureYahooSession({ getcrumbRetryDelaysMs: [0, 0] });
      assert.equal(again.crumb, null);
      assert.equal(calls.length, 7);
      assert.equal(calls.filter((u) => u.includes("getcrumb")).length, 6);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("retries getcrumb after 429 and succeeds on second attempt", async () => {
    const orig = globalThis.fetch;
    let getcrumbHits = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: {
            "set-cookie": "A3=retry-ok; Domain=.yahoo.com; Path=/; Secure",
          },
        });
      }
      if (u.includes("getcrumb")) {
        getcrumbHits += 1;
        if (getcrumbHits === 1) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response("crumb-after-retry", { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    };
    try {
      const s = await sessionMod.ensureYahooSession({
        force: true,
        getcrumbRetryDelaysMs: [0, 0],
      });
      assert.equal(s.cookie, "A3=retry-ok");
      assert.equal(s.crumb, "crumb-after-retry");
      assert.equal(getcrumbHits, 2);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("tries query2 getcrumb after query1 returns 429", async () => {
    const orig = globalThis.fetch;
    const getcrumbHosts = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: {
            "set-cookie": "A3=alt-host; Domain=.yahoo.com; Path=/; Secure",
          },
        });
      }
      if (u.includes("getcrumb")) {
        getcrumbHosts.push(new URL(u).hostname);
        if (u.includes("query1.finance.yahoo.com")) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response("crumb-from-query2", { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    };
    try {
      const s = await sessionMod.ensureYahooSession({
        force: true,
        getcrumbRetryDelaysMs: [0, 0],
      });
      assert.equal(s.crumb, "crumb-from-query2");
      assert.deepEqual(getcrumbHosts, [
        "query1.finance.yahoo.com",
        "query2.finance.yahoo.com",
      ]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("bootstraps cookie+crumb via ensureYahooSession", async () => {
    const orig = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: {
            "set-cookie":
              "A3=tok123; Domain=.yahoo.com; Path=/; SameSite=None; Secure; HttpOnly",
          },
        });
      }
      if (u.includes("getcrumb")) {
        return new Response("crumb-xyz", { status: 200 });
      }
      throw new Error(`unexpected fetch ${u}`);
    };
    try {
      const s = await sessionMod.ensureYahooSession({ force: true });
      assert.equal(s.cookie, "A3=tok123");
      assert.equal(s.crumb, "crumb-xyz");
      assert.equal(calls.length, 2);
      // Second call without force reuses cache (no extra fetch).
      const again = await sessionMod.ensureYahooSession();
      assert.equal(again.crumb, "crumb-xyz");
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("worker yahoo session injection", () => {
  beforeEach(() => {
    workerMod.resetYahooSession();
  });

  it("injects cookie+crumb on options and returns Yahoo data", async () => {
    const orig = globalThis.fetch;
    const upstreamCalls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = new Headers(init.headers || {});
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: {
            "set-cookie": "A3=session-a3; Domain=.yahoo.com; Path=/; Secure; HttpOnly",
          },
        });
      }
      if (u.includes("/v1/test/getcrumb")) {
        assert.equal(headers.get("cookie"), "A3=session-a3");
        return new Response("live-crumb", { status: 200 });
      }
      if (u.includes("/v7/finance/options/SPY")) {
        upstreamCalls.push({
          url: u,
          cookie: headers.get("cookie"),
        });
        const crumb = new URL(u).searchParams.get("crumb");
        if (crumb === "live-crumb" && (headers.get("cookie") || "").includes("A3=session-a3")) {
          return new Response(JSON.stringify({ optionChain: { result: [{ symbol: "SPY" }] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            finance: { result: null, error: { code: "Unauthorized", description: "Invalid Crumb" } },
          }),
          { status: 401 },
        );
      }
      throw new Error(`unexpected ${u}`);
    };

    try {
      const res = await worker.fetch(
        req("/query1/v7/finance/options/SPY", {
          headers: { "X-Proxy-Key": "secret" },
        }),
        { PROXY_KEY: "secret" },
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.optionChain.result[0].symbol, "SPY");
      assert.equal(upstreamCalls.length, 1);
      assert.match(upstreamCalls[0].url, /crumb=live-crumb/);
      assert.match(upstreamCalls[0].cookie, /A3=session-a3/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("buffers final upstream body after 401 retry (no disturbed ReadableStream 502)", async () => {
    const orig = globalThis.fetch;
    let optionsHits = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = new Headers(init.headers || {});
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: { "set-cookie": "A3=a3-retry; Domain=.yahoo.com; Path=/" },
        });
      }
      if (u.includes("/v1/test/getcrumb")) {
        return new Response("fresh-crumb", { status: 200 });
      }
      if (u.includes("/v7/finance/options/SPY")) {
        optionsHits += 1;
        if (optionsHits === 1) {
          return new Response(
            JSON.stringify({ finance: { error: { code: "Unauthorized" } } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        const crumb = new URL(u).searchParams.get("crumb");
        if (crumb === "fresh-crumb" && (headers.get("cookie") || "").includes("A3=a3-retry")) {
          return new Response(JSON.stringify({ optionChain: { symbol: "SPY" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("still bad", { status: 401 });
      }
      throw new Error(`unexpected ${u}`);
    };

    try {
      const res = await worker.fetch(
        req("/query1/v7/finance/options/SPY", {
          headers: { "X-Proxy-Key": "secret" },
        }),
        { PROXY_KEY: "secret" },
      );
      assert.equal(res.status, 200);
      assert.notEqual(res.status, 502);
      const body = await res.json();
      assert.deepEqual(body, { optionChain: { symbol: "SPY" } });
      assert.equal(optionsHits, 2);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("continues without crumb only after getcrumb retries exhausted on 401 refresh", async () => {
    const orig = globalThis.fetch;
    let optionsHits = 0;
    let getcrumbHits = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = new Headers(init.headers || {});
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: { "set-cookie": "A3=a3-rate; Domain=.yahoo.com; Path=/" },
        });
      }
      if (u.includes("/v1/test/getcrumb")) {
        getcrumbHits += 1;
        return new Response("Too Many Requests", { status: 429 });
      }
      if (u.includes("/v7/finance/options/SPY")) {
        optionsHits += 1;
        assert.match(headers.get("cookie") || "", /A3=a3-rate/);
        assert.equal(new URL(u).searchParams.has("crumb"), false);
        return new Response("unauthorized", { status: 401 });
      }
      throw new Error(`unexpected ${u}`);
    };

    try {
      const res = await worker.fetch(
        req("/query1/v7/finance/options/SPY", {
          headers: { "X-Proxy-Key": "secret" },
        }),
        { PROXY_KEY: "secret" },
      );
      assert.equal(res.status, 401);
      assert.notEqual(res.status, 502);
      assert.equal(optionsHits, 2);
      assert.ok(getcrumbHits >= 6);
      const body = await res.text();
      assert.doesNotMatch(body, /proxy_failed|disturbed|getcrumb failed/i);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("options succeed when getcrumb recovers after initial 429", async () => {
    const orig = globalThis.fetch;
    let getcrumbHits = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = new Headers(init.headers || {});
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", {
          status: 404,
          headers: { "set-cookie": "A3=a3-recover; Domain=.yahoo.com; Path=/" },
        });
      }
      if (u.includes("/v1/test/getcrumb")) {
        getcrumbHits += 1;
        if (getcrumbHits === 1) {
          return new Response("Too Many Requests", { status: 429 });
        }
        return new Response("recovered-crumb", { status: 200 });
      }
      if (u.includes("/v7/finance/options/SPY")) {
        const crumb = new URL(u).searchParams.get("crumb");
        if (crumb === "recovered-crumb" && (headers.get("cookie") || "").includes("A3=a3-recover")) {
          return new Response(JSON.stringify({ optionChain: { result: [{ symbol: "SPY" }] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("unauthorized", { status: 401 });
      }
      throw new Error(`unexpected ${u}`);
    };

    try {
      const res = await worker.fetch(
        req("/query1/v7/finance/options/SPY", {
          headers: { "X-Proxy-Key": "secret" },
        }),
        { PROXY_KEY: "secret" },
      );
      assert.equal(res.status, 200);
      assert.ok(getcrumbHits >= 2 && getcrumbHits <= 3);
      const body = await res.json();
      assert.equal(body.optionChain.result[0].symbol, "SPY");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("returns proxy_failed when session refresh fails fatally after 401", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.startsWith("https://fc.yahoo.com")) {
        return new Response("", { status: 404, headers: {} });
      }
      if (u.includes("/v7/finance/options/SPY")) {
        return new Response("unauthorized", { status: 401 });
      }
      throw new Error(`unexpected ${u}`);
    };

    try {
      const res = await worker.fetch(
        req("/query1/v7/finance/options/SPY", {
          headers: { "X-Proxy-Key": "secret" },
        }),
        { PROXY_KEY: "secret" },
      );
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, "proxy_failed");
      assert.match(body.message, /yahoo_session/i);
      assert.doesNotMatch(body.message, /disturbed/i);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("refreshes session and retries once after upstream 401", async () => {
    const orig = globalThis.fetch;
    let optionsHits = 0;
    let crumbVersion = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const headers = new Headers(init.headers || {});
      if (u.startsWith("https://fc.yahoo.com")) {
        crumbVersion += 1;
        return new Response("", {
          status: 404,
          headers: {
            "set-cookie": `A3=a3-v${crumbVersion}; Domain=.yahoo.com; Path=/`,
          },
        });
      }
      if (u.includes("/v1/test/getcrumb")) {
        return new Response(`crumb-v${crumbVersion}`, { status: 200 });
      }
      if (u.includes("/v7/finance/options/SPY")) {
        optionsHits += 1;
        const crumb = new URL(u).searchParams.get("crumb");
        if (optionsHits === 1) {
          return new Response("unauthorized", { status: 401 });
        }
        if (crumb === "crumb-v2" && (headers.get("cookie") || "").includes("A3=a3-v2")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("still bad", { status: 401 });
      }
      throw new Error(`unexpected ${u}`);
    };

    try {
      const res = await worker.fetch(
        req("/query1/v7/finance/options/SPY", {
          headers: { "X-Proxy-Key": "secret" },
        }),
        { PROXY_KEY: "secret" },
      );
      assert.equal(res.status, 200);
      assert.equal(optionsHits, 2);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
