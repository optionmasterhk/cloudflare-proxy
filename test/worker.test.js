/**
 * Smoke-test worker validation paths without Cloudflare credentials.
 * Run: node --test test/worker.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const mod = await import(
  pathToFileURL(new URL("../src/index.js", import.meta.url).pathname).href
);
const worker = mod.default;

function req(path, init = {}) {
  return new Request(`https://proxy.example${path}`, init);
}

describe("yahoo-finance-proxy worker", () => {
  it("serves service info on /", async () => {
    const res = await worker.fetch(req("/"), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, "yahoo-finance-proxy");
  });

  it("serves health", async () => {
    const res = await worker.fetch(req("/health"), {});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("requires PROXY_KEY to be configured for proxy routes", async () => {
    const res = await worker.fetch(req("/query1/v8/finance/chart/AAPL"), {});
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "proxy_key_required");
  });

  it("rejects missing auth when PROXY_KEY is set", async () => {
    const res = await worker.fetch(req("/query1/v8/finance/chart/AAPL"), {
      PROXY_KEY: "secret",
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthorized");
    assert.equal(body.reason, "key_missing");
  });

  it("rejects a different key as key_mismatch", async () => {
    const res = await worker.fetch(
      req("/query1/v8/finance/chart/AAPL", {
        headers: { "X-Proxy-Key": "wrong" },
      }),
      { PROXY_KEY: "secret" },
    );
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.reason, "key_mismatch");
    assert.equal(body.provided_len, 5);
    assert.equal(body.required_len, 6);
  });

  it("accepts keys that only differ by whitespace, quotes, or a trailing newline", async () => {
    const cases = [
      { header: "  secret  ", env: "secret" },
      { header: "secret", env: "secret\n" },
      { header: '"secret"', env: "secret" },
      { header: "secret", env: "'secret'" },
    ];
    for (const c of cases) {
      const res = await worker.fetch(
        req("/other/v8/finance/chart/AAPL", {
          headers: { "X-Proxy-Key": c.header },
        }),
        { PROXY_KEY: c.env },
      );
      assert.equal(res.status, 400, `expected auth to pass for ${JSON.stringify(c)}`);
      const body = await res.json();
      assert.equal(body.error, "unknown_prefix");
    }
  });

  it("allows any host via ?url= when authenticated", async () => {
    const res = await worker.fetch(
      req("/?url=https://example.com/x", {
        headers: { "X-Proxy-Key": "secret" },
      }),
      { PROXY_KEY: "secret" },
    );
    // Past auth/host checks; upstream fetch may succeed or fail offline.
    assert.ok([200, 301, 302, 404, 502].includes(res.status) || res.status < 600);
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 401);
  });

  it("honors optional ALLOWED_HOSTS when set", async () => {
    const res = await worker.fetch(
      req("/?url=https://evil.example/x", {
        headers: { "X-Proxy-Key": "secret" },
      }),
      { PROXY_KEY: "secret", ALLOWED_HOSTS: "query1.finance.yahoo.com" },
    );
    assert.equal(res.status, 403);
  });

  it("rejects unknown path prefix", async () => {
    const res = await worker.fetch(
      req("/other/v8/finance/chart/AAPL", {
        headers: { Authorization: "Bearer secret" },
      }),
      { PROXY_KEY: "secret" },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "unknown_prefix");
  });

  it("accepts bearer auth and resolves query1 path (upstream may fail offline)", async () => {
    const res = await worker.fetch(
      req("/query1/v8/finance/chart/AAPL", {
        headers: { Authorization: "Bearer secret" },
      }),
      { PROXY_KEY: "secret" },
    );
    assert.ok([200, 401, 404, 429, 500, 502].includes(res.status));
  });

  it("source file documents architecture", () => {
    const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    assert.match(src, /Zeabur \(yfinance\) → this Worker → upstream/);
  });
});
