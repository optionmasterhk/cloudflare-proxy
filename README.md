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
npx wrangler secret put PROXY_KEY   # 必須打喺呢個 Worker（name = cloudflare-proxy）
npm run deploy
```

部署後會得到類似：

`https://cloudflare-proxy.<your-subdomain>.workers.dev`

### 2. 在 Zeabur 設定環境變數

| 變數 | 說明 |
|------|------|
| `YF_PROXY_BASE` | Worker URL，例如 `https://cloudflare-proxy.xxx.workers.dev` |
| `YF_PROXY_KEY` | 與 **同一個** Worker 的 `PROXY_KEY` 相同（唔好加引號／換行） |

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
| Query URL（任意 host） | `GET /?url=https://example.com/path` |

認證靠 `PROXY_KEY` 把關；**預設不限 host**。若要自行收緊，可設可選變數 `ALLOWED_HOSTS`（逗號分隔）。

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

## 401 點分辨？

| 現象 | 意思 |
|------|------|
| Worker 回 JSON `{"error":"unauthorized","reason":"key_mismatch"}` | **PROXY_KEY** 同 Zeabur `YF_PROXY_KEY` 唔啱 |
| Observability 入面 `fetch` span 打去 `query1.finance.yahoo.com`，status **401**，body ~89 bytes | **Yahoo** Invalid Crumb／缺 cookie（舊版）；而家 Worker 會自己 bootstrap `A3`+crumb 並喺 401 時 refresh 再試一次 |

Yahoo 嘅 `/v7/finance/options/...`、`/v7/finance/quote` 要 cookie + crumb。Worker 會：

1. 直接向 `fc.yahoo.com` / `getcrumb` 攞 session（isolate 內 cache）
2. 自動加喺轉發去 Yahoo 嘅請求
3. 上游仍 401/403 就 force refresh 再 retry 一次
4. 同時剝走 `Set-Cookie` 嘅 `Domain=.yahoo.com`，方便 client jar

所以就算 Zeabur 端 cookie jar 留唔住 Yahoo domain，都應該可以經 proxy 攞到 options／quote 數據。

## 安全建議

1. **一定要設 `PROXY_KEY`**（代理路由強制要求）；密鑰即通行證，唔再靠 host allowlist。`wrangler.toml` 嘅 `name` 必須係 `cloudflare-proxy`，否則 `wrangler secret put` 會寫去另一個 Worker，Zeabur 打 `cloudflare-proxy.*.workers.dev` 就會 401。
2. 不要把密鑰寫進前端或公開 repo。
3. 如需額外限制上游，可選設 `ALLOWED_HOSTS`。
4. 免費額度夠「幾十個 ticker、定期更新」；高頻輪詢請自行節流。
5. **DEBUG_AUTH**（預設 `1`）：proxy-auth 401/503 會喺 **custom** Worker log（唔係嗰條 `GET …` invocation）印 `[auth-debug]`，同時把兩邊 key 放進 JSON body 嘅 `debug`（TG `/checkproxy` 會顯示）。Dashboard 自動 request log 永遠把 `x-proxy-key` 顯示成 `REDACTED`。對完之後設 `DEBUG_AUTH=0` 並 rotate key。
6. Yahoo 上游 401/403 會打 `[upstream] … (proxy auth already OK)` custom log（含 `has_cookie` / `has_crumb`）。

## 指令

| 指令 | 說明 |
|------|------|
| `npm run dev` | 本地 Worker |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run tail` | 即時 log |
| `npm test` | 單元測試 |

## License

MIT
