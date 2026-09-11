/**
 * Yahoo Finance anonymous session (A3 cookie + crumb).
 *
 * Kept in isolate memory so warm Workers reuse it across requests.
 * Used when clients (yfinance via path-prefix proxy) fail to keep
 * Domain=.yahoo.com cookies on *.workers.dev.
 */

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SESSION_TTL_MS = 50 * 60 * 1000;

const GETCRUMB_URLS = [
  "https://query1.finance.yahoo.com/v1/test/getcrumb",
  "https://query2.finance.yahoo.com/v1/test/getcrumb",
];

/** getcrumb attempts alternate query1 / query2. Override delays via opts.getcrumbRetryDelaysMs in tests. */
const GETCRUMB_ATTEMPT_COUNT = 6;

/** Backoff before attempts 2–6 (ms). Override via opts.getcrumbRetryDelaysMs in tests. */
const DEFAULT_GETCRUMB_RETRY_DELAYS_MS = [2000, 5000, 10000, 10000, 15000];

/** @type {{ cookie: string|null, crumb: string|null, fetchedAt: number }} */
let session = { cookie: null, crumb: null, fetchedAt: 0 };

export function resetYahooSession() {
  session = { cookie: null, crumb: null, fetchedAt: 0 };
}

export function peekYahooSession() {
  return { ...session };
}

export function isYahooApiHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return (
    h === "query1.finance.yahoo.com" ||
    h === "query2.finance.yahoo.com" ||
    h === "fc.yahoo.com" ||
    h === "finance.yahoo.com" ||
    h.endsWith(".finance.yahoo.com")
  );
}

/** Paths that mint cookies/crumbs — do not inject our session into these. */
export function isYahooSessionBootstrapPath(pathname) {
  const p = String(pathname || "");
  return p === "/" || p === "" || p.includes("/v1/test/getcrumb");
}

/**
 * Most quote/options/fundamentals endpoints need crumb; chart often does not.
 * Injecting an unused crumb is harmless; missing crumb causes 401.
 */
export function shouldInjectCrumb(target) {
  if (!isYahooApiHost(target.hostname)) return false;
  if (target.hostname === "fc.yahoo.com") return false;
  if (isYahooSessionBootstrapPath(target.pathname)) return false;
  return true;
}

export function parseSetCookiePairs(upstream) {
  const raw =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
  if (raw.length === 0) {
    const single = upstream.headers.get("set-cookie");
    if (single) raw.push(single);
  }
  const pairs = [];
  for (const line of raw) {
    const nv = String(line).split(";")[0].trim();
    if (nv.includes("=")) pairs.push(nv);
  }
  return pairs;
}

export function mergeCookieHeader(existing, ...pairs) {
  const map = new Map();
  const add = (chunk) => {
    for (const part of String(chunk || "").split(";")) {
      const nv = part.trim();
      if (!nv || !nv.includes("=")) continue;
      const eq = nv.indexOf("=");
      const name = nv.slice(0, eq).trim();
      const value = nv.slice(eq + 1).trim();
      if (name) map.set(name, value);
    }
  };
  add(existing);
  for (const p of pairs) add(p);
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function cookieFresh() {
  return Boolean(
    session.cookie && Date.now() - session.fetchedAt < SESSION_TTL_MS,
  );
}

function sessionFresh() {
  return cookieFresh() && Boolean(session.crumb);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGetcrumbRateLimited(status, text) {
  return status === 429 || /too many requests/i.test(String(text || ""));
}

function crumbLooksValid(text) {
  const c = String(text || "").trim();
  if (!c) return false;
  if (c.includes(" ")) return false;
  if (/too many requests/i.test(c)) return false;
  if (/^</.test(c)) return false; // HTML error page
  if (c.length > 200) return false;
  return true;
}

function getcrumbDelayBeforeAttempt(attemptIndex, retryDelaysMs) {
  if (attemptIndex <= 0) return 0;
  const idx = attemptIndex - 1;
  if (idx < retryDelaysMs.length) return retryDelaysMs[idx];
  const last = retryDelaysMs[retryDelaysMs.length - 1];
  return last ?? DEFAULT_GETCRUMB_RETRY_DELAYS_MS[DEFAULT_GETCRUMB_RETRY_DELAYS_MS.length - 1];
}

/**
 * Try getcrumb on query1/query2 with backoff. Returns a crumb or null when every
 * attempt is rate-limited. Non-429 failures throw immediately.
 * @param {string} a3
 * @param {string} ua
 * @param {number[]} retryDelaysMs
 */
async function fetchCrumbWithRetries(a3, ua, retryDelaysMs) {
  let lastStatus = 0;
  let lastBody = "";

  for (let i = 0; i < GETCRUMB_ATTEMPT_COUNT; i++) {
    const delayBefore = getcrumbDelayBeforeAttempt(i, retryDelaysMs);
    if (delayBefore > 0) await sleep(delayBefore);

    const url = GETCRUMB_URLS[i % GETCRUMB_URLS.length];

    const crumbRes = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Accept: "*/*",
        Cookie: a3,
      },
    });
    const crumbText = (await crumbRes.text()).trim();

    if (crumbRes.ok && crumbLooksValid(crumbText)) {
      return { crumb: crumbText, rateLimited: false };
    }
    if (isGetcrumbRateLimited(crumbRes.status, crumbText)) {
      lastStatus = crumbRes.status;
      lastBody = crumbText;
      console.log({
        message: "[yahoo-session] getcrumb rate-limited; will retry",
        status: crumbRes.status,
        host: new URL(url).hostname,
        body: crumbText.slice(0, 80),
      });
      continue;
    }

    throw new Error(
      `yahoo_session: getcrumb failed status=${crumbRes.status} body=${crumbText.slice(0, 80)}`,
    );
  }

  return { crumb: null, rateLimited: true, status: lastStatus, body: lastBody };
}

/**
 * Bootstrap A3 + crumb directly against Yahoo (not via this Worker).
 * @param {{ userAgent?: string, force?: boolean, getcrumbRetryDelaysMs?: number[] }} [opts]
 */
export async function ensureYahooSession(opts = {}) {
  const force = Boolean(opts.force);
  const ua = opts.userAgent || DEFAULT_UA;
  const retryDelaysMs = opts.getcrumbRetryDelaysMs ?? DEFAULT_GETCRUMB_RETRY_DELAYS_MS;
  if (!force && sessionFresh()) return session;

  let a3 = !force && cookieFresh() ? session.cookie : null;
  if (!a3) {
    const fcRes = await fetch("https://fc.yahoo.com/", {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Accept: "*/*",
      },
      redirect: "manual",
    });
    const cookiePairs = parseSetCookiePairs(fcRes);
    a3 = cookiePairs.find((p) => p.toLowerCase().startsWith("a3="));
    if (!a3) {
      throw new Error("yahoo_session: no A3 cookie from fc.yahoo.com");
    }
  }

  const crumbResult = await fetchCrumbWithRetries(a3, ua, retryDelaysMs);
  if (crumbResult.rateLimited) {
    console.log({
      message: "[yahoo-session] getcrumb rate-limited after retries; continuing without crumb",
      status: crumbResult.status,
      body: crumbResult.body.slice(0, 80),
    });
    session = {
      cookie: a3,
      crumb: force && session.crumb ? session.crumb : null,
      fetchedAt: Date.now(),
    };
    return session;
  }

  session = {
    cookie: a3,
    crumb: crumbResult.crumb,
    fetchedAt: Date.now(),
  };
  return session;
}

/**
 * Apply cached (or freshly fetched) cookie+crumb onto an upstream target/headers.
 * Mutates `target` search params and `headers`.
 */
export async function applyYahooSession(target, headers, opts = {}) {
  if (!isYahooApiHost(target.hostname)) return null;
  if (target.hostname === "fc.yahoo.com") return null;
  if (isYahooSessionBootstrapPath(target.pathname) && target.pathname.includes("getcrumb")) {
    // Still attach cookie for getcrumb if we have one.
    try {
      const s = await ensureYahooSession(opts);
      headers.set("Cookie", mergeCookieHeader(headers.get("Cookie"), s.cookie));
      return s;
    } catch {
      return null;
    }
  }
  if (isYahooSessionBootstrapPath(target.pathname)) return null;

  const s = await ensureYahooSession(opts);
  headers.set("Cookie", mergeCookieHeader(headers.get("Cookie"), s.cookie));
  if (shouldInjectCrumb(target) && s.crumb) {
    if (!target.searchParams.has("crumb") || opts.replaceCrumb) {
      target.searchParams.set("crumb", s.crumb);
    }
  }
  return s;
}
