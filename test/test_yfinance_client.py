"""Unit tests for Yahoo URL rewriting (no network)."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


def _load():
    path = Path(__file__).resolve().parents[1] / "examples" / "yfinance_client.py"
    spec = importlib.util.spec_from_file_location("yfinance_client", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


class RewriteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load()

    def test_query1(self):
        out = self.mod.rewrite_yahoo_url(
            "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d",
            "https://proxy.example",
        )
        self.assertEqual(
            out,
            "https://proxy.example/query1/v8/finance/chart/AAPL?interval=1d",
        )

    def test_fc(self):
        out = self.mod.rewrite_yahoo_url("https://fc.yahoo.com/", "https://proxy.example/")
        self.assertEqual(out, "https://proxy.example/fc/")

    def test_non_yahoo(self):
        self.assertIsNone(
            self.mod.rewrite_yahoo_url("https://example.com/x", "https://proxy.example")
        )


class CookieAdoptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load()

    def test_adopts_yahoo_domain_cookies_onto_proxy_host(self):
        session = self.mod._requests.Session()
        # Simulate jar entry still scoped to Yahoo (old Worker behavior).
        session.cookies.set("A3", "token-value", domain=".yahoo.com", path="/")
        n = self.mod.adopt_yahoo_cookies_for_proxy(session, "https://cloudflare-proxy.example.workers.dev")
        self.assertGreaterEqual(n, 1)
        # Proxy-host cookie should be present for later Worker calls.
        matched = [
            c
            for c in session.cookies
            if c.name == "A3" and "workers.dev" in (c.domain or "")
        ]
        self.assertTrue(matched, "expected A3 cookie rebound to workers.dev host")


if __name__ == "__main__":
    unittest.main()
