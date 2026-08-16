# Cloudflare Yahoo Finance Proxy

自建 **Cloudflare Worker** 免費代理，讓跑在 **Zeabur** 上的應用繼續用 `yfinance` 穩定抓取 Yahoo Finance。

```
Zeabur (yfinance)  →  Cloudflare Worker  →  Yahoo Finance
```

## 為什麼需要？

- Yahoo Finance 容易封鎖雲主機 / 資料中心 IP（Zeabur 等）。
- Cloudflare Worker **免費方案每日 100,000 次請求**，IP 池極大，Yahoo 幾乎不會封鎖 Cloudflare 出口 IP。
- Worker 只做極簡反向代理（轉發 + 可選密鑰），不改 yfinance 使用方式。

## 快速開始

### 1. 部署 Worker

```bash
npm install
npx wrangler login
npx wrangler secret put PROXY_KEY   # 設一組長隨機字串
npm run deploy
```

部署後會得到類似：

`https://yahoo-finance-proxy.<your-subdomain>.workers.dev`

### 2. 在 Zeabur 設定環境變數

| 變數 | 說明 |
|------|------|
| `YF_PROXY_BASE` | Worker URL，例如 `https://yahoo-finance-proxy.xxx.workers.dev` |
| `YF_PROXY_KEY` | 與 `PROXY_KEY` 相同的密鑰 |

### 3. Python（繼續用 yfinance）

```python
import yfinance as yf
from examples.yfinance_client import make_session

session = make_session()  # 讀取 YF_PROXY_BASE / YF_PROXY_KEY
ticker = yf.Ticker("AAPL", session=session)
print(ticker.history(period="5d"))
```

或把 `examples/yfinance_client.py` 複製進你的 Zeabur 專案後：

```python
from yfinance_client import make_session
```

## 代理路徑

| 寫法 | 範例 |
|------|------|
| Path prefix（建議） | `GET /query1/v8/finance/chart/AAPL` |
| | `GET /query2/v1/test/getcrumb` |
| | `GET /fc/` |
| Query URL | `GET /?url=https://query1.finance.yahoo.com/v8/finance/chart/AAPL` |

允許的上游主機（預設）：

- `query1.finance.yahoo.com`
- `query2.finance.yahoo.com`
- `fc.yahoo.com`
- `finance.yahoo.com`

認證（若有設定 `PROXY_KEY`）：

```http
X-Proxy-Key: <PROXY_KEY>
# 或
Authorization: Bearer <PROXY_KEY>
```

## 本地開發

```bash
cp .dev.vars.example .dev.vars   # 編輯 PROXY_KEY
npm install
npm run dev
# 另開終端
export YF_PROXY_BASE=http://127.0.0.1:8787
export YF_PROXY_KEY=dev-local-proxy-key
pip install -r examples/requirements.txt
python examples/yfinance_client.py
```

注意：`wrangler dev` 的上游請求會從**本機 IP** 出去，Yahoo 仍可能回 429。正式部署後，出口改為 Cloudflare IP，才是這套架構的重點。
## 專案結構

```
├── src/index.js                 # Worker 本體
├── wrangler.toml                # Cloudflare 設定
├── examples/yfinance_client.py  # Zeabur / yfinance session 輔助
├── examples/requirements.txt
├── test/worker.test.js
└── package.json
```

## 安全建議

1. **一定要設 `PROXY_KEY`**，否則任何人都能打你的免費額度。
2. 不要把密鑰寫進前端或公開 repo。
3. 僅允許 Yahoo 相關 host（程式內已寫死 allowlist）。
4. 免費額度夠「幾十個 ticker、定期更新」；高頻輪詢請自行節流。

## 指令

| 指令 | 說明 |
|------|------|
| `npm run dev` | 本地 Worker |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run tail` | 即時 log |
| `npm test` | 單元測試 |

## License

MIT
