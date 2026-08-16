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
 */

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
]);

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

function enforceAuth(request, env) {
  const required = normalizeSecret(env && env.PROXY_KEY);
  if (!required) {
    return json(
      {
        error: "proxy_key_required",
        hint: "Set Worker secret PROXY_KEY on this Worker (npx wrangler secret put PROXY_KEY). Auth replaces host allowlists.",
      },
      503,
    );
  }

  const headerKey = normalizeSecret(request.headers.get("X-Proxy-Key"));
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? normalizeSecret(auth.slice(7))
    : "";
  const provided = headerKey || bearer;

  if (!provided || !secretsEqual(provided, required)) {
    return json(
      {
        error: "unauthorized",
        reason: provided ? "key_mismatch" : "key_missing",
        hint: "X-Proxy-Key / Authorization Bearer must match Worker secret PROXY_KEY.",
        provided_len: provided.length,
        required_len: required.length,
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

  const init = {
    method: request.method,
    headers,
    redirect: "follow",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const upstream = await fetch(target.toString(), init);
  const responseHeaders = new Headers(upstream.headers);
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
