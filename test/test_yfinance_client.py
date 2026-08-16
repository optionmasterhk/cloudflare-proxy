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


if __name__ == "__main__":
    unittest.main()
