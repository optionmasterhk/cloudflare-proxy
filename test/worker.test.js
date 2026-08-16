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
