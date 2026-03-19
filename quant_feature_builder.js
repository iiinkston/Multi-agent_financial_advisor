import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const REQUIRED_STATE_FEATURES = [
  "return_1d",
  "return_5d",
  "return_10d",
  "MA_gap",
  "volatility_10",
  "volume_change",
  "RSI_14",
  "MACD",
  "trend_strength",
  "regime_volatility",
  "bull_flag",
  "downside_volatility",
  "rolling_downside_mean",
  "rolling_skewness",
  "trend_persistence",
  "recent_drawdown",
  "ma_slope",
  "bear_market_flag",
];

function normalizeMarket(market) {
  if (!market) return market;
  const m = String(market).trim().toLowerCase();
  const aliasMap = {
    sgx: "SG",
    singapore: "SG",
    "hong kong": "HK",
    hkex: "HK",
    china: "CN",
    "a-share": "CN",
    "a share": "CN",
    "mainland china": "CN",
    london: "UK",
    lse: "UK",
    "united states": "US",
    "us market": "US",
    nasdaq: "US",
    nyse: "US",
  };
  if (aliasMap[m]) return aliasMap[m];
  const upper = m.toUpperCase();
  if (["US", "UK", "CN", "SG", "HK"].includes(upper)) return upper;
  return market;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function skewness(values) {
  if (values.length < 3) return null;
  const avg = mean(values);
  const sd = std(values);
  if (!sd || sd === 0) return 0;
  const n = values.length;
  const m3 =
    values.reduce((sum, v) => sum + (v - avg) ** 3, 0) / n;
  return m3 / sd ** 3;
}

function rolling(values, window, fn) {
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i += 1) {
    const slice = values.slice(i - window + 1, i + 1);
    if (slice.some((v) => v == null)) continue;
    out[i] = fn(slice);
  }
  return out;
}

function rollingMax(values, window) {
  return rolling(values, window, (slice) => Math.max(...slice));
}

function pctChange(values, period = 1) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    const prev = values[i - period];
    const curr = values[i];
    if (prev == null || curr == null || prev === 0) continue;
    out[i] = curr / prev - 1;
  }
  return out;
}

function ewmMeanAdjustTrue(values, span) {
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (span + 1);
  for (let t = 0; t < values.length; t += 1) {
    if (values[t] == null) continue;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i <= t; i += 1) {
      if (values[i] == null) continue;
      const weight = (1 - alpha) ** (t - i);
      numerator += weight * values[i];
      denominator += weight;
    }
    out[t] = denominator === 0 ? null : numerator / denominator;
  }
  return out;
}

function computeRSI(closes, window = 14) {
  const deltas = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i] == null || closes[i - 1] == null) continue;
    deltas[i] = closes[i] - closes[i - 1];
  }
  const gains = deltas.map((d) => (d != null && d > 0 ? d : 0));
  const losses = deltas.map((d) => (d != null && d < 0 ? -d : 0));
  const avgGain = rolling(gains, window, mean);
  const avgLoss = rolling(losses, window, mean);
  const rsi = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    if (avgGain[i] == null || avgLoss[i] == null) continue;
    const rs = avgGain[i] / (avgLoss[i] + 1e-8);
    rsi[i] = 100 - 100 / (1 + rs);
  }
  return rsi;
}

async function fetchHistorical(symbol, provider, startDate, endDate) {
  const client = new Client({ name: "quant-feature-builder", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp-openbb-server.js"],
  });

  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "equity_price_historical",
      arguments: {
        symbol,
        provider,
        start_date: startDate,
        end_date: endDate,
        interval: "1d",
      },
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    await client.close();
  }
}

async function fetchHistoricalWithYfinance(symbol, startDate, endDate) {
  const pythonExecutable = process.env.PYTHON_EXECUTABLE || "python";
  const args = ["-c", `
import json
import sys
import yfinance as yf

symbol = sys.argv[1]
start_date = sys.argv[2]
end_date = sys.argv[3]

df = yf.download(symbol, start=start_date, end=end_date)
rows = []
if df is not None and not df.empty:
    df = df.reset_index()
    for _, row in df.iterrows():
        rows.append({
            "date": str(row["Date"])[:10],
            "open": None if row.get("Open") is None else float(row["Open"]),
            "high": None if row.get("High") is None else float(row["High"]),
            "low": None if row.get("Low") is None else float(row["Low"]),
            "close": None if row.get("Close") is None else float(row["Close"]),
            "volume": None if row.get("Volume") is None else float(row["Volume"]),
        })

print(json.dumps({"rows": rows}))
  `.trim(), symbol, startDate, endDate];

  return new Promise((resolve) => {
    const child = spawn(pythonExecutable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      resolve({ ok: false, error: String(err), stderr });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `python_exit_${code}`, stderr });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({ ok: true, data: parsed, stderr });
      } catch (e) {
        resolve({ ok: false, error: "invalid_json", raw: stdout, stderr });
      }
    });
  });
}

function fetchHistoricalFromDataset(market) {
  const datasetPath = path.join(process.cwd(), "knowledge", "global_trading_dataset.csv");
  if (!fs.existsSync(datasetPath)) {
    return { ok: false, error: "dataset_missing" };
  }
  try {
    const content = fs.readFileSync(datasetPath, "utf-8");
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
      return { ok: false, error: "dataset_empty" };
    }
    const header = lines[0].split(",");
    const idx = (name) => header.indexOf(name);
    const marketIdx = idx("market");
    const dateIdx = idx("date");
    const openIdx = idx("open");
    const highIdx = idx("high");
    const lowIdx = idx("low");
    const closeIdx = idx("close");
    const volumeIdx = idx("volume");

    if ([marketIdx, dateIdx, openIdx, highIdx, lowIdx, closeIdx, volumeIdx].some((i) => i < 0)) {
      return { ok: false, error: "dataset_missing_columns" };
    }

    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const parts = lines[i].split(",");
      if (parts.length <= Math.max(marketIdx, volumeIdx)) continue;
      if (parts[marketIdx] !== market) continue;
      rows.push({
        date: parts[dateIdx],
        open: parts[openIdx] === "" ? null : Number(parts[openIdx]),
        high: parts[highIdx] === "" ? null : Number(parts[highIdx]),
        low: parts[lowIdx] === "" ? null : Number(parts[lowIdx]),
        close: parts[closeIdx] === "" ? null : Number(parts[closeIdx]),
        volume: parts[volumeIdx] === "" ? null : Number(parts[volumeIdx]),
      });
    }
    return { ok: true, rows };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function buildQuantFeatures({
  market,
  ticker,
  position = 0,
  provider = "yfinance",
  lookbackDays = 200,
}) {
  const notes = [];
  const normalizedMarket = normalizeMarket(market);
  if (normalizedMarket !== market) {
    notes.push(`market_input=${market}`);
    notes.push(`market_normalized=${normalizedMarket}`);
  }
  market = normalizedMarket;
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - lookbackDays);

  const response = await fetchHistorical(
    ticker,
    provider,
    formatDate(startDate),
    formatDate(endDate)
  );

  const toolResult = response?.result || null;
  const structured = toolResult?.structuredContent || null;
  const rows = structured?.rows;
  const diagnostics = {
    tool: "equity_price_historical",
    provider,
    request: {
      symbol: ticker,
      start_date: formatDate(startDate),
      end_date: formatDate(endDate),
      interval: "1d",
    },
    mcp_ok: response?.ok === true,
    has_structuredContent: Boolean(structured),
    has_rows: Array.isArray(rows),
    row_count: Array.isArray(rows) ? rows.length : 0,
    structured_error: structured?.error || null,
    raw_keys: structured?.raw ? Object.keys(structured.raw) : null,
    tool_text: Array.isArray(toolResult?.content)
      ? toolResult.content.map((c) => c?.text).filter(Boolean).join(" | ")
      : null,
    mcp_error: response?.ok === false ? response.error : null,
  };
  if (!Array.isArray(rows) || rows.length === 0) {
    const fallback = await fetchHistoricalWithYfinance(
      ticker,
      formatDate(startDate),
      formatDate(endDate)
    );
    if (fallback.ok && Array.isArray(fallback.data?.rows) && fallback.data.rows.length > 0) {
      notes.push("history_fallback=yfinance");
      const fallbackRows = fallback.data.rows;
      const sortedFallback = fallbackRows
        .map((r) => ({
          date: r.date,
          open: r.open == null ? null : Number(r.open),
          high: r.high == null ? null : Number(r.high),
          low: r.low == null ? null : Number(r.low),
          close: r.close == null ? null : Number(r.close),
          volume: r.volume == null ? null : Number(r.volume),
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const fallbackCloses = sortedFallback.map((r) => r.close);
      const fallbackVolumes = sortedFallback.map((r) => r.volume);

      if (sortedFallback.length < 60) {
        return {
          error: "insufficient_history",
          market,
          ticker,
          notes: [...notes, `rows=${sortedFallback.length}`, "min_required=60"],
          diagnostics,
        };
      }

      const rawReturn1d = pctChange(fallbackCloses, 1);
      const return5d = pctChange(fallbackCloses, 5);
      const return10d = pctChange(fallbackCloses, 10);

      const ma5 = rolling(fallbackCloses, 5, mean);
      const ma20 = rolling(fallbackCloses, 20, mean);
      const ma50 = rolling(fallbackCloses, 50, mean);
      const maGap = ma5.map((v, i) => (v != null && ma20[i] ? v / ma20[i] - 1 : null));
      const trendStrength = maGap.slice();

      const bullFlag = ma5.map((v, i) =>
        v != null && ma20[i] != null ? (v > ma20[i] ? 1 : 0) : null
      );
      const bearMarketFlag = fallbackCloses.map((v, i) =>
        v != null && ma50[i] != null ? (v < ma50[i] ? 1 : 0) : null
      );

      const regimeVolRaw = rolling(rawReturn1d, 20, std);
      const regimeVol = regimeVolRaw.slice();
      const vol10 = rolling(rawReturn1d, 10, std);

      const volumeChange = pctChange(fallbackVolumes, 1);

      const rsi14 = computeRSI(fallbackCloses, 14);

      const ema12 = ewmMeanAdjustTrue(fallbackCloses, 12);
      const ema26 = ewmMeanAdjustTrue(fallbackCloses, 26);
      const macd = ema12.map((v, i) => (v != null && ema26[i] != null ? v - ema26[i] : null));

      const negReturns = rawReturn1d.map((v) => (v != null && v > 0 ? 0 : v));
      const rollingDownsideMean = rolling(negReturns, 20, mean);
      const downsideVolatility = rolling(negReturns, 20, std);
      const rollingSkew = rolling(rawReturn1d, 20, skewness);

      const trendPersistence = rolling(rawReturn1d.map((v) => (v == null ? null : Math.sign(v))), 20, mean);
      const rollingMaxValues = rollingMax(fallbackCloses, 60);
      const recentDrawdown = fallbackCloses.map((v, i) =>
        v != null && rollingMaxValues[i] != null ? v / (rollingMaxValues[i] + 1e-8) - 1 : null
      );

      const maSlope = ma20.map((v, i) => {
        if (v == null || i < 5 || ma20[i - 5] == null) return null;
        return (v - ma20[i - 5]) / 5;
      });

      const featureRows = fallbackCloses.map((_, i) => ({
        return_1d: rawReturn1d[i],
        return_5d: return5d[i],
        return_10d: return10d[i],
        MA_gap: maGap[i],
        volatility_10: vol10[i],
        volume_change: volumeChange[i],
        RSI_14: rsi14[i],
        MACD: macd[i],
        trend_strength: trendStrength[i],
        regime_volatility: regimeVol[i],
        bull_flag: bullFlag[i],
        downside_volatility: downsideVolatility[i],
        rolling_downside_mean: rollingDownsideMean[i],
        rolling_skewness: rollingSkew[i],
        trend_persistence: trendPersistence[i],
        recent_drawdown: recentDrawdown[i],
        ma_slope: maSlope[i],
        bear_market_flag: bearMarketFlag[i],
      }));

      let idx = featureRows.length - 1;
      while (idx >= 0) {
        const row = featureRows[idx];
        const missing = REQUIRED_STATE_FEATURES.filter((k) => row[k] == null || Number.isNaN(row[k]));
        if (missing.length === 0) break;
        idx -= 1;
      }

      if (idx < 0) {
        return {
          error: "insufficient_valid_features",
          market,
          ticker,
          notes: [...notes, "no_complete_feature_row_found"],
          diagnostics,
        };
      }

      const features = featureRows[idx];
      const missing = REQUIRED_STATE_FEATURES.filter((k) => features[k] == null || Number.isNaN(features[k]));
      if (missing.length > 0) {
        return {
          error: "feature_row_incomplete",
          market,
          ticker,
          notes: [...notes, `missing=${missing.join(",")}`],
          diagnostics,
        };
      }

      return {
        market,
        ticker,
        features,
        position,
        notes: [...notes, `rows=${sortedFallback.length}`, `feature_index=${idx}`],
      };
    }

    const datasetFallback = fetchHistoricalFromDataset(market);
    if (datasetFallback.ok && datasetFallback.rows.length > 0) {
      notes.push("history_fallback=dataset");
      const fallbackRows = datasetFallback.rows;
      const sortedFallback = fallbackRows
        .map((r) => ({
          date: r.date,
          open: r.open == null ? null : Number(r.open),
          high: r.high == null ? null : Number(r.high),
          low: r.low == null ? null : Number(r.low),
          close: r.close == null ? null : Number(r.close),
          volume: r.volume == null ? null : Number(r.volume),
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      const fallbackCloses = sortedFallback.map((r) => r.close);
      const fallbackVolumes = sortedFallback.map((r) => r.volume);

      if (sortedFallback.length < 60) {
        return {
          error: "insufficient_history",
          market,
          ticker,
          notes: [...notes, `rows=${sortedFallback.length}`, "min_required=60"],
          diagnostics,
        };
      }

      const rawReturn1d = pctChange(fallbackCloses, 1);
      const return5d = pctChange(fallbackCloses, 5);
      const return10d = pctChange(fallbackCloses, 10);

      const ma5 = rolling(fallbackCloses, 5, mean);
      const ma20 = rolling(fallbackCloses, 20, mean);
      const ma50 = rolling(fallbackCloses, 50, mean);
      const maGap = ma5.map((v, i) => (v != null && ma20[i] ? v / ma20[i] - 1 : null));
      const trendStrength = maGap.slice();

      const bullFlag = ma5.map((v, i) =>
        v != null && ma20[i] != null ? (v > ma20[i] ? 1 : 0) : null
      );
      const bearMarketFlag = fallbackCloses.map((v, i) =>
        v != null && ma50[i] != null ? (v < ma50[i] ? 1 : 0) : null
      );

      const regimeVolRaw = rolling(rawReturn1d, 20, std);
      const regimeVol = regimeVolRaw.slice();
      const vol10 = rolling(rawReturn1d, 10, std);

      const volumeChange = pctChange(fallbackVolumes, 1);

      const rsi14 = computeRSI(fallbackCloses, 14);

      const ema12 = ewmMeanAdjustTrue(fallbackCloses, 12);
      const ema26 = ewmMeanAdjustTrue(fallbackCloses, 26);
      const macd = ema12.map((v, i) => (v != null && ema26[i] != null ? v - ema26[i] : null));

      const negReturns = rawReturn1d.map((v) => (v != null && v > 0 ? 0 : v));
      const rollingDownsideMean = rolling(negReturns, 20, mean);
      const downsideVolatility = rolling(negReturns, 20, std);
      const rollingSkew = rolling(rawReturn1d, 20, skewness);

      const trendPersistence = rolling(rawReturn1d.map((v) => (v == null ? null : Math.sign(v))), 20, mean);
      const rollingMaxValues = rollingMax(fallbackCloses, 60);
      const recentDrawdown = fallbackCloses.map((v, i) =>
        v != null && rollingMaxValues[i] != null ? v / (rollingMaxValues[i] + 1e-8) - 1 : null
      );

      const maSlope = ma20.map((v, i) => {
        if (v == null || i < 5 || ma20[i - 5] == null) return null;
        return (v - ma20[i - 5]) / 5;
      });

      const featureRows = fallbackCloses.map((_, i) => ({
        return_1d: rawReturn1d[i],
        return_5d: return5d[i],
        return_10d: return10d[i],
        MA_gap: maGap[i],
        volatility_10: vol10[i],
        volume_change: volumeChange[i],
        RSI_14: rsi14[i],
        MACD: macd[i],
        trend_strength: trendStrength[i],
        regime_volatility: regimeVol[i],
        bull_flag: bullFlag[i],
        downside_volatility: downsideVolatility[i],
        rolling_downside_mean: rollingDownsideMean[i],
        rolling_skewness: rollingSkew[i],
        trend_persistence: trendPersistence[i],
        recent_drawdown: recentDrawdown[i],
        ma_slope: maSlope[i],
        bear_market_flag: bearMarketFlag[i],
      }));

      let idx = featureRows.length - 1;
      while (idx >= 0) {
        const row = featureRows[idx];
        const missing = REQUIRED_STATE_FEATURES.filter((k) => row[k] == null || Number.isNaN(row[k]));
        if (missing.length === 0) break;
        idx -= 1;
      }

      if (idx < 0) {
        return {
          error: "insufficient_valid_features",
          market,
          ticker,
          notes: [...notes, "no_complete_feature_row_found"],
          diagnostics,
        };
      }

      const features = featureRows[idx];
      const missing = REQUIRED_STATE_FEATURES.filter((k) => features[k] == null || Number.isNaN(features[k]));
      if (missing.length > 0) {
        return {
          error: "feature_row_incomplete",
          market,
          ticker,
          notes: [...notes, `missing=${missing.join(",")}`],
          diagnostics,
        };
      }

      return {
        market,
        ticker,
        features,
        position,
        notes: [...notes, `rows=${sortedFallback.length}`, `feature_index=${idx}`],
      };
    }

    return {
      error: "no_history_rows",
      market,
      ticker,
      notes,
      diagnostics: {
        ...diagnostics,
        fallback: fallback.ok
          ? { row_count: fallback.data?.rows?.length || 0 }
          : { error: fallback.error, stderr: fallback.stderr || null },
        dataset_fallback: datasetFallback.ok
          ? { row_count: datasetFallback.rows.length }
          : { error: datasetFallback.error },
      },
    };
  }

  const sorted = rows
    .map((r) => ({
      date: r.date,
      open: r.open == null ? null : Number(r.open),
      high: r.high == null ? null : Number(r.high),
      low: r.low == null ? null : Number(r.low),
      close: r.close == null ? null : Number(r.close),
      volume: r.volume == null ? null : Number(r.volume),
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const closes = sorted.map((r) => r.close);
  const volumes = sorted.map((r) => r.volume);

  if (sorted.length < 60) {
    return {
      error: "insufficient_history",
      market,
      ticker,
      notes: [...notes, `rows=${sorted.length}`, "min_required=60"],
    };
  }

  const rawReturn1d = pctChange(closes, 1);
  const return5d = pctChange(closes, 5);
  const return10d = pctChange(closes, 10);

  const ma5 = rolling(closes, 5, mean);
  const ma20 = rolling(closes, 20, mean);
  const ma50 = rolling(closes, 50, mean);
  const maGap = ma5.map((v, i) => (v != null && ma20[i] ? v / ma20[i] - 1 : null));
  const trendStrength = maGap.slice();

  const bullFlag = ma5.map((v, i) =>
    v != null && ma20[i] != null ? (v > ma20[i] ? 1 : 0) : null
  );
  const bearMarketFlag = closes.map((v, i) =>
    v != null && ma50[i] != null ? (v < ma50[i] ? 1 : 0) : null
  );

  const regimeVolRaw = rolling(rawReturn1d, 20, std);
  const regimeVol = regimeVolRaw.slice();
  const vol10 = rolling(rawReturn1d, 10, std);

  const volumeChange = pctChange(volumes, 1);

  const rsi14 = computeRSI(closes, 14);

  const ema12 = ewmMeanAdjustTrue(closes, 12);
  const ema26 = ewmMeanAdjustTrue(closes, 26);
  const macd = ema12.map((v, i) => (v != null && ema26[i] != null ? v - ema26[i] : null));

  const negReturns = rawReturn1d.map((v) => (v != null && v > 0 ? 0 : v));
  const rollingDownsideMean = rolling(negReturns, 20, mean);
  const downsideVolatility = rolling(negReturns, 20, std);
  const rollingSkew = rolling(rawReturn1d, 20, skewness);

  const trendPersistence = rolling(rawReturn1d.map((v) => (v == null ? null : Math.sign(v))), 20, mean);
  const rollingMaxValues = rollingMax(closes, 60);
  const recentDrawdown = closes.map((v, i) =>
    v != null && rollingMaxValues[i] != null ? v / (rollingMaxValues[i] + 1e-8) - 1 : null
  );

  const maSlope = ma20.map((v, i) => {
    if (v == null || i < 5 || ma20[i - 5] == null) return null;
    return (v - ma20[i - 5]) / 5;
  });

  const featureRows = closes.map((_, i) => ({
    return_1d: rawReturn1d[i],
    return_5d: return5d[i],
    return_10d: return10d[i],
    MA_gap: maGap[i],
    volatility_10: vol10[i],
    volume_change: volumeChange[i],
    RSI_14: rsi14[i],
    MACD: macd[i],
    trend_strength: trendStrength[i],
    regime_volatility: regimeVol[i],
    bull_flag: bullFlag[i],
    downside_volatility: downsideVolatility[i],
    rolling_downside_mean: rollingDownsideMean[i],
    rolling_skewness: rollingSkew[i],
    trend_persistence: trendPersistence[i],
    recent_drawdown: recentDrawdown[i],
    ma_slope: maSlope[i],
    bear_market_flag: bearMarketFlag[i],
  }));

  let idx = featureRows.length - 1;
  while (idx >= 0) {
    const row = featureRows[idx];
    const missing = REQUIRED_STATE_FEATURES.filter((k) => row[k] == null || Number.isNaN(row[k]));
    if (missing.length === 0) break;
    idx -= 1;
  }

  if (idx < 0) {
    return {
      error: "insufficient_valid_features",
      market,
      ticker,
      notes: [...notes, "no_complete_feature_row_found"],
    };
  }

  const features = featureRows[idx];
  const missing = REQUIRED_STATE_FEATURES.filter((k) => features[k] == null || Number.isNaN(features[k]));
  if (missing.length > 0) {
    return {
      error: "feature_row_incomplete",
      market,
      ticker,
      notes: [...notes, `missing=${missing.join(",")}`],
    };
  }

  return {
    market,
    ticker,
    features,
    position,
    notes: [...notes, `rows=${sorted.length}`, `feature_index=${idx}`],
  };
}

export const REQUIRED_FEATURES = REQUIRED_STATE_FEATURES;

// Market alias examples:
// SGX -> SG
// Singapore -> SG
// HKEX -> HK
// A-share -> CN
// LSE -> UK
// Nasdaq -> US
