/**
 * Minimal reverse proxy for Cloudflare Workers (yfinance / Zeabur friendly).
 *
 * Architecture: Zeabur (yfinance) → this Worker → upstream
 *
 * Auth is the gate: set Worker secret PROXY_KEY. With a valid key, any
 * http(s) upstream is allowed. Optional ALLOWED_HOSTS can still restrict.
 *
 * Supported request shapes:
 *   1) Full URL query (any host):
 *        /?url=https://query1.finance.yahoo.com/v8/finance/chart/AAPL
 *   2) Yahoo path shortcuts:
 *        /query1/v8/finance/chart/AAPL
 *        /query2/v1/test/getcrumb
 *        /fc/   (→ https://fc.yahoo.com/)
 *        /finance/...
 *
 * Auth: Authorization: Bearer <key>  or  X-Proxy-Key: <key>
 *
 * Yahoo cookie/crumb: Worker bootstraps A3 + crumb against Yahoo and injects
 * them on API calls (and retries once on upstream 401/403), so options/quote
 * work even when client jars cannot keep Domain=.yahoo.com cookies.
 */

import {
  applyYahooSession,
  isYahooApiHost,
  resetYahooSession,
} from "./yahoo-session.js";

const HOST_ALIASES = {
  query1: "query1.finance.yahoo.com",
  query2: "query2.finance.yahoo.com",
  fc: "fc.yahoo.com",
  finance: "finance.yahoo.com",
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "x-real-ip",
  "x-proxy-key",
  // Never forward the Worker gate token to Yahoo (Bearer PROXY_KEY).
  "authorization",
]);

/**
 * Yahoo sets `Domain=.yahoo.com` on A3/consent cookies. Clients talk to the
 * Worker host (*.workers.dev), so those cookies never stick / never get sent
 * on later /query1|/query2|/fc calls — Yahoo then 401s options/quote with
 * Invalid Crumb. Strip Domain so the cookie scopes to the Worker host.
 */
function rewriteUpstreamCookie(raw) {
  const parts = String(raw)
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return raw;
  const [nameValue, ...attrs] = parts;
  const kept = attrs.filter((attr) => {
    const name = attr.split("=")[0].trim().toLowerCase();
    return name !== "domain";
  });
  return [nameValue, ...kept].join("; ");
}

function copyUpstreamHeaders(upstream) {
  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    responseHeaders.append(key, value);
  }

  const cookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
  for (const cookie of cookies) {
    responseHeaders.append("set-cookie", rewriteUpstreamCookie(cookie));
  }
  return responseHeaders;
}

export { rewriteUpstreamCookie, copyUpstreamHeaders, resetYahooSession };

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return corsPreflight(request);
      }

      const url = new URL(request.url);

      if (url.pathname === "/" && !url.searchParams.has("url")) {
        return json(
          {
            service: "yahoo-finance-proxy",
            architecture: "Zeabur → Cloudflare Worker → upstream",
            usage: {
              any_host: "/?url=https://example.com/path",
              yahoo_shortcut: "/query1/v8/finance/chart/AAPL",
              auth: "Authorization: Bearer <PROXY_KEY>  or  X-Proxy-Key: <PROXY_KEY>",
            },
          },
          200,
        );
      }

      if (url.pathname === "/health") {
        return json({ ok: true }, 200);
      }

      const authError = enforceAuth(request, env);
      if (authError) return authError;

      const target = resolveTarget(url, env);
      if (target instanceof Response) return target;

      return await proxyRequest(request, target);
    } catch (err) {
      return json(
        { error: "proxy_failed", message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  },
};

/** Optional allowlist. Empty / unset → all hosts allowed (PROXY_KEY is the gate). */
function allowedHosts(env) {
  const raw = (env && env.ALLOWED_HOSTS) || "";
  if (!raw.trim()) return null;
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostPermitted(hostname, env) {
  const allow = allowedHosts(env);
  if (!allow) return true;
  return allow.includes(hostname.toLowerCase());
}

/** Strip BOM / surrounding quotes / whitespace from secrets and header values. */
function normalizeSecret(value) {
  if (value == null) return "";
  let s = String(value);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function secretsEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function toHex(s) {
  return Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
}

/** Inspect a secret for logs. Hex / spaced forms survive CF secret redaction. */
function inspectSecret(raw) {
  const s = raw == null ? "" : String(raw);
  return {
    present: raw != null && s.length > 0,
    len: s.length,
    raw: s,
    json: JSON.stringify(s),
    hex: toHex(s),
    spaced: Array.from(s).join(" "),
    normalized: normalizeSecret(s),
    normalized_len: normalizeSecret(s).length,
  };
}

function headerValues(request, name) {
  const want = name.toLowerCase();
  const values = [];
  for (const [key, value] of request.headers) {
    if (key.toLowerCase() === want) values.push(value);
  }
  return values;
}

function authCandidates(headerRaw, bearerRaw) {
  const out = [];
  const push = (v) => {
    const n = normalizeSecret(v);
    if (n && !out.includes(n)) out.push(n);
  };
  push(headerRaw);
  push(bearerRaw);
  for (const part of String(headerRaw || "").split(/,\s*/)) push(part);
  return out;
}

function debugAuthEnabled(env) {
  const flag = env && env.DEBUG_AUTH;
  if (flag == null || flag === "") return true;
  return !["0", "false", "off", "no"].includes(String(flag).trim().toLowerCase());
}

function logAuth(event, details) {
  // Object form is indexed as a *custom* Workers Log (not the GET invocation).
  console.log({
    message: `[auth-debug] ${event}`,
    auth_debug: event,
    ...details,
  });
}

function authDebugPayload(request, env, headerRaw, bearerRaw, headerList, candidates, provided, required) {
  return {
    incoming_header: inspectSecret(headerRaw),
    incoming_bearer: inspectSecret(bearerRaw),
    worker_secret: inspectSecret(env && env.PROXY_KEY),
    env_keys: env ? Object.keys(env) : [],
    header_names: [...request.headers.keys()],
    header_values_count: headerList.length,
    candidates,
    equal_after_normalize: secretsEqual(provided, required),
  };
}

function enforceAuth(request, env) {
  const requiredRaw = env && env.PROXY_KEY;
  const required = normalizeSecret(requiredRaw);
  const headerRaw = request.headers.get("X-Proxy-Key");
  const headerList = headerValues(request, "X-Proxy-Key");
  const auth = request.headers.get("Authorization") || "";
  const bearerRaw = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  const candidates = authCandidates(headerRaw, bearerRaw);
  const provided = candidates[0] || "";
  const matched = required ? candidates.some((c) => secretsEqual(c, required)) : false;

  if (!required) {
    const debug = debugAuthEnabled(env)
      ? authDebugPayload(request, env, headerRaw, bearerRaw, headerList, candidates, provided, required)
      : null;
    if (debug) logAuth("proxy_key_unset", { path: new URL(request.url).pathname, ...debug });
    return json(
      {
        error: "proxy_key_required",
        hint: "Set Worker secret PROXY_KEY on this Worker (npx wrangler secret put PROXY_KEY). Auth replaces host allowlists.",
        ...(debug ? { debug } : {}),
      },
      503,
    );
  }

  if (!matched) {
    const reason = provided ? "key_mismatch" : "key_missing";
    const debug = debugAuthEnabled(env)
      ? authDebugPayload(request, env, headerRaw, bearerRaw, headerList, candidates, provided, required)
      : null;
    if (debug) logAuth(reason, { path: new URL(request.url).pathname, ...debug });
    return json(
      {
        error: "unauthorized",
        reason,
        hint: "X-Proxy-Key / Authorization Bearer must match Worker secret PROXY_KEY.",
        provided_len: provided.length,
        required_len: required.length,
        ...(debug ? { debug } : {}),
      },
      401,
    );
  }
  return null;
}

function resolveTarget(url, env) {
  const viaQuery = url.searchParams.get("url");
  if (viaQuery) {
    let dest;
    try {
      dest = new URL(viaQuery);
    } catch {
      return json({ error: "invalid_url" }, 400);
    }
    if (!["http:", "https:"].includes(dest.protocol)) {
      return json({ error: "invalid_protocol" }, 400);
    }
    if (!hostPermitted(dest.hostname, env)) {
      return json({ error: "host_not_allowed", host: dest.hostname }, 403);
    }
    return dest;
  }

  // Yahoo shortcuts: /query1/...  /query2/...  /fc/...  /finance/...
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    return json({ error: "missing_target" }, 400);
  }

  const alias = parts[0].toLowerCase();
  const host = HOST_ALIASES[alias];
  if (!host) {
    return json(
      {
        error: "unknown_prefix",
        hint: "Use /?url=https://host/path for any host, or Yahoo shortcuts /query1|/query2|/fc|/finance/...",
      },
      400,
    );
  }
  if (!hostPermitted(host, env)) {
    return json({ error: "host_not_allowed", host }, 403);
  }

  const rest = parts.slice(1).join("/");
  const dest = new URL(`https://${host}/${rest}`);
  dest.search = url.search;
  return dest;
}

async function proxyRequest(request, target) {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "host") continue;
    headers.set(key, value);
  }

  if (!headers.has("User-Agent")) {
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
  }
  if (!headers.has("Accept")) {
    headers.set("Accept", "*/*");
  }

  const yahoo = isYahooApiHost(target.hostname);
  const dest = new URL(target.toString());

  if (yahoo) {
    try {
      await applyYahooSession(dest, headers, {
        userAgent: headers.get("User-Agent") || undefined,
      });
    } catch (err) {
      console.log({
        message: "[yahoo-session] bootstrap failed (continuing without)",
        error: err instanceof Error ? err.message : String(err),
        path: dest.pathname,
      });
    }
  }

  const init = {
    method: request.method,
    headers,
    redirect: "follow",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  let upstream = await fetch(dest.toString(), init);

  // Cookie/crumb can expire or be mismatched; refresh once and retry.
  if (yahoo && (upstream.status === 401 || upstream.status === 403)) {
    console.log({
      message: `[upstream] ${dest.hostname} returned ${upstream.status}; refreshing Yahoo session`,
      upstream_status: upstream.status,
      upstream_host: dest.hostname,
      upstream_path: dest.pathname,
      has_cookie: headers.has("cookie"),
      has_crumb: dest.searchParams.has("crumb"),
    });
    try {
      // Drain body so the connection can be reused cleanly.
      await upstream.arrayBuffer().catch(() => {});
      await applyYahooSession(dest, headers, {
        userAgent: headers.get("User-Agent") || undefined,
        force: true,
        replaceCrumb: true,
      });
      upstream = await fetch(dest.toString(), init);
    } catch (err) {
      console.log({
        message: "[yahoo-session] refresh failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (yahoo && (upstream.status === 401 || upstream.status === 403)) {
    console.log({
      message: `[upstream] ${dest.hostname} returned ${upstream.status} after session inject (proxy auth already OK)`,
      upstream_status: upstream.status,
      upstream_host: dest.hostname,
      upstream_path: dest.pathname,
      has_cookie: headers.has("cookie"),
      has_crumb: dest.searchParams.has("crumb"),
    });
  }

  const responseHeaders = copyUpstreamHeaders(upstream);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");
  responseHeaders.set("Vary", "Origin, Authorization, X-Proxy-Key");
  if (!responseHeaders.has("Cache-Control")) {
    responseHeaders.set("Cache-Control", "no-store");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function corsPreflight(request) {
  const reqHeaders = request.headers.get("Access-Control-Request-Headers") || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": reqHeaders,
      "Access-Control-Max-Age": "86400",
    },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
