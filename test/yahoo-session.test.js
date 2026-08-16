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
