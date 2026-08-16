/**
 * Minimal Yahoo Finance reverse proxy for Cloudflare Workers.
 *
 * Architecture: Zeabur (yfinance) → this Worker → Yahoo Finance
 *
 * Supported request shapes:
 *   1) Path prefix (preferred for yfinance):
 *        /query1/v8/finance/chart/AAPL
 *        /query2/v1/test/getcrumb
 *        /fc/   (→ https://fc.yahoo.com/)
 *        /finance/...
 *   2) Full URL query:
 *        /?url=https://query1.finance.yahoo.com/v8/finance/chart/AAPL
 *
 * Auth (recommended): set Worker secret PROXY_KEY, then send either
 *   Authorization: Bearer <key>  or  X-Proxy-Key: <key>
 */

const DEFAULT_ALLOWED_HOSTS = [
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "fc.yahoo.com",
  "finance.yahoo.com",
];

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
            architecture: "Zeabur → Cloudflare Worker → Yahoo Finance",
            usage: {
              path: "/query1/v8/finance/chart/AAPL",
              query: "/?url=https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
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

function allowedHosts(env) {
  const raw = (env && env.ALLOWED_HOSTS) || "";
  if (!raw.trim()) return DEFAULT_ALLOWED_HOSTS;
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function enforceAuth(request, env) {
  const required = env && env.PROXY_KEY;
  if (!required) return null;

  const headerKey = request.headers.get("X-Proxy-Key");
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  const provided = headerKey || bearer;

  if (!provided || provided !== required) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function resolveTarget(url, env) {
  const allow = allowedHosts(env);

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
    if (!allow.includes(dest.hostname.toLowerCase())) {
      return json({ error: "host_not_allowed", host: dest.hostname }, 403);
    }
    return dest;
  }

  // /query1/...  /query2/...  /fc/...  /finance/...
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
        hint: "Use /query1/..., /query2/..., /fc/..., /finance/..., or ?url=",
      },
      400,
    );
  }
  if (!allow.includes(host)) {
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

  // Yahoo is picky about missing UA; keep caller UA or supply a browser-like default.
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
  // Avoid caching personalized / crumb responses at shared caches by default.
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
