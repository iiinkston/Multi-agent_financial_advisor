## Market data tools (OpenBB data layer)

This project exposes a small, provider‑agnostic market data layer via MCP tools. All tools are implemented in `mcp-openbb-server.js` and use OpenBB (`from openbb import obb`) under the hood.

The tools share a **normalized response schema** via `structuredContent` so LLM agents can reason reliably regardless of provider.

---

### Tool: `equity_quote`

- **Purpose**: Real‑time (or latest) equity quote from OpenBB providers.
- **Input**
  - **symbol**: `string` – Ticker symbol (e.g. `"AAPL"`, `"NVDA"`, `"700.HK"`).
  - **provider**: `string` – Data provider. Defaults to `"yfinance"` if omitted.
    - Allowed values: `yfinance`, `stooq`, `fmp`, `intrinio`, `polygon`, `tiingo`, `tradier`, `tmx`, `alpha_vantage`.
- **Output (`structuredContent`)**
  - **symbol**: `string`
  - **provider**: `string`
  - **timestamp**: `string` (ISO or provider‑supplied time)
  - **price**: `number | null`
  - **open**: `number | null`
  - **high**: `number | null`
  - **low**: `number | null`
  - **prevClose**: `number | null`
  - **currency**: `string | null`
  - **raw**: `object` – Original provider/OpenBB payload (may be empty).

Example call (JSON arguments):

```json
{
  "symbol": "NVDA",
  "provider": "yfinance"
}
```

---

### Tool: `equity_price_historical`

- **Purpose**: Historical OHLCV prices for an equity from OpenBB providers.
- **Input**
  - **symbol**: `string`
  - **provider**: `string` – Defaults to `"yfinance"` if omitted.
  - **start_date**: `string | undefined` – `"YYYY-MM-DD"`, inclusive.
  - **end_date**: `string | undefined` – `"YYYY-MM-DD"`, inclusive.
  - **interval**: `string` – Defaults to `"1d"` (daily).
- **Output (`structuredContent`)**
  - **symbol**: `string`
  - **provider**: `string`
  - **start_date**: `string | null`
  - **end_date**: `string | null`
  - **interval**: `string`
  - **rows**: `Array<{ date, open, high, low, close, volume }>`
    - **date**: `string`
    - **open**: `number | null`
    - **high**: `number | null`
    - **low**: `number | null`
    - **close**: `number | null`
    - **volume**: `number | null`
  - **raw**: `object` – Original provider/OpenBB payload (may be empty).

Example call (JSON arguments):

```json
{
  "symbol": "NVDA",
  "provider": "yfinance",
  "start_date": "2024-11-01",
  "end_date": "2024-12-15",
  "interval": "1d"
}
```

---

### Tool: `equity_search`

- **Purpose**: Search equities by symbol or name via OpenBB providers.
- **Input**
  - **query**: `string` – e.g. `"Nvidia"`, `"NVDA"`.
  - **provider**: `string` – Defaults to `"yfinance"` if omitted.
- **Output (`structuredContent`)**
  - **provider**: `string`
  - **query**: `string`
  - **results**: `Array<object>` – Provider/OpenBB search results.
  - **raw**: `object` – Original provider/OpenBB payload (may be empty).

Example call (JSON arguments):

```json
{
  "query": "Nvidia",
  "provider": "yfinance"
}
```

---

### Tool: `quant_signal`

- **Purpose**: Return a model-driven trading signal from the PPO quant model.
- **Input**
  - **market**: `string` – Market identifier (e.g., `"US"`, `"HK"`).
  - **ticker**: `string` – Ticker symbol (e.g., `"AAPL"`, `"700.HK"`).
  - **features**: `object` – Feature payload for the model (precomputed).
- **Output (`structuredContent`)**
  - **signal**: `"BUY" | "SELL" | "HOLD"`
  - **position**: `number` (range `[-1, 1]`)
  - **confidence**: `number` (0 to 1)
  - **raw_action**: `number` (range `[-1, 1]`)
  - **model**: `string` (e.g., `"ppo_v1"`)

Example call (JSON arguments):

```json
{
  "market": "US",
  "ticker": "AAPL",
  "features": {
    "trend_strength_raw": 0.32,
    "MA_gap_raw": 0.18,
    "regime_volatility_raw": 0.12,
    "raw_return_1d": 0.004
  }
}
```

---

### Tool usage contract (for agents)

- **Always specify `provider`** in calls to `equity_quote`, `equity_price_historical`, and `equity_search` (use `"yfinance"` by default; `"stooq"` is a recommended free fallback).
- **Historical data**: always provide explicit `start_date`, `end_date`, and `interval` (e.g. `"1d"`).
- **Reasoning**: assume tools return both `content` (human‑readable summary) and `structuredContent` (normalized data with a `raw` field).
- **Citations**: when answering, clearly mention the `symbol` and `provider` used, and distinguish real‑time quotes from historical data.

