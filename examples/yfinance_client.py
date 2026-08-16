"""
Zeabur / local helper: route yfinance traffic through the Cloudflare Worker.

Usage on Zeabur (or any Python host):

  export YF_PROXY_BASE=https://yahoo-finance-proxy.<subdomain>.workers.dev
  export YF_PROXY_KEY=your-secret   # must match Worker secret PROXY_KEY

  from examples.yfinance_client import make_session
  import yfinance as yf

  session = make_session()
  t = yf.Ticker("AAPL", session=session)
  print(t.history(period="5d"))
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import quote, urlsplit, urlunsplit

# yfinance prefers curl_cffi when available.
try:
    from curl_cffi import requests as _requests

    _IMPORTER = "curl_cffi"
except ImportError:  # pragma: no cover
    import requests as _requests  # type: ignore

    _IMPORTER = "requests"


YAHOO_HOSTS = {
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "fc.yahoo.com",
    "finance.yahoo.com",
}

HOST_TO_PREFIX = {
    "query1.finance.yahoo.com": "query1",
    "query2.finance.yahoo.com": "query2",
    "fc.yahoo.com": "fc",
    "finance.yahoo.com": "finance",
}


def rewrite_yahoo_url(url: str, proxy_base: str) -> Optional[str]:
    """Rewrite a Yahoo Finance URL onto the Worker path-prefix form."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host not in YAHOO_HOSTS:
        return None

    prefix = HOST_TO_PREFIX[host]
    base = proxy_base.rstrip("/")
    path = parts.path if parts.path.startswith("/") else f"/{parts.path}"
    rewritten = f"{base}/{prefix}{path}"
    if parts.query:
        rewritten = f"{rewritten}?{parts.query}"
    return rewritten


class YahooProxySession(_requests.Session):
    """Session that tunnels Yahoo hosts through the Cloudflare Worker."""

    def __init__(
        self,
        proxy_base: Optional[str] = None,
        proxy_key: Optional[str] = None,
        use_query_param: bool = False,
        **kwargs,
    ):
        if _IMPORTER == "curl_cffi" and "impersonate" not in kwargs:
            kwargs["impersonate"] = "chrome"
        super().__init__(**kwargs)
        self.proxy_base = (proxy_base or os.environ.get("YF_PROXY_BASE", "")).rstrip("/")
        self.proxy_key = proxy_key if proxy_key is not None else os.environ.get("YF_PROXY_KEY", "")
        self.use_query_param = use_query_param
        if not self.proxy_base:
            raise ValueError(
                "YF_PROXY_BASE is required (e.g. https://yahoo-finance-proxy.xxx.workers.dev)"
            )

    def request(self, method, url, **kwargs):  # type: ignore[override]
        headers = dict(kwargs.pop("headers", None) or {})
        if self.proxy_key:
            headers.setdefault("X-Proxy-Key", self.proxy_key)

        if self.use_query_param and any(h in url for h in YAHOO_HOSTS):
            proxied = f"{self.proxy_base}/?url={quote(url, safe='')}"
            return super().request(method, proxied, headers=headers, **kwargs)

        rewritten = rewrite_yahoo_url(str(url), self.proxy_base)
        if rewritten is not None:
            return super().request(method, rewritten, headers=headers, **kwargs)

        return super().request(method, url, headers=headers, **kwargs)


def make_session(
    proxy_base: Optional[str] = None,
    proxy_key: Optional[str] = None,
    use_query_param: bool = False,
) -> YahooProxySession:
    """Create a yfinance-ready session routed via the Worker."""
    return YahooProxySession(
        proxy_base=proxy_base,
        proxy_key=proxy_key,
        use_query_param=use_query_param,
    )


def demo(symbol: str = "AAPL") -> None:
    import yfinance as yf

    session = make_session()
    ticker = yf.Ticker(symbol, session=session)
    hist = ticker.history(period="5d")
    print(hist.tail())
    print("fast_info.last_price =", getattr(ticker.fast_info, "last_price", None))


if __name__ == "__main__":
    demo(os.environ.get("YF_SYMBOL", "AAPL"))
