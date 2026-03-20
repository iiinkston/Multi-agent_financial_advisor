#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import { spawn } from "child_process";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sentimentLabel(score) {
  if (score >= 0.2) return "positive";
  if (score <= -0.2) return "negative";
  return "neutral";
}

function clampScore(value, min = -1, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, n));
}

function mapQuantToScore(quant) {
  const signal = (quant?.signal || quant?.quant_signal || "").toUpperCase();
  let base = 0;
  if (signal === "BUY") base = 1;
  if (signal === "SELL") base = -1;
  if (signal === "HOLD") base = 0;

  let conf = quant?.confidence;
  if (conf == null) {
    conf = signal === "HOLD" ? 0 : 0.5;
  }
  const bounded = clampScore(conf, 0, 1);
  return base * bounded;
}

function labelMarketMood(score) {
  if (score >= 0.2) return "bullish";
  if (score <= -0.2) return "bearish";
  return "neutral";
}

function computeTrend(delta) {
  if (delta >= 0.1) return "improving";
  if (delta <= -0.1) return "worsening";
  return "stable";
}

function fuseTradeSignals(quant, sentiment, marketMood) {
  const quantScore = clampScore(mapQuantToScore(quant));
  const sentimentScore = clampScore(sentiment?.sentiment_score ?? 0);
  const marketMoodScore = clampScore(marketMood?.market_mood_score ?? 0);

  const finalScore = 0.65 * quantScore + 0.25 * sentimentScore + 0.1 * marketMoodScore;
  const finalSignal = finalScore >= 0.25 ? "BUY" : finalScore <= -0.25 ? "SELL" : "HOLD";
  const finalConfidence = Math.min(1, Math.abs(finalScore));

  const reasons = [];
  if (quantScore > 0) reasons.push("quant_primary_buy");
  if (quantScore < 0) reasons.push("quant_primary_sell");
  if (quantScore === 0) reasons.push("quant_primary_hold");
  if (sentimentScore >= 0.2) reasons.push("sentiment_supportive");
  if (sentimentScore <= -0.2) reasons.push("sentiment_headwind");
  if (marketMoodScore >= 0.2) reasons.push("market_mood_supportive");
  if (marketMoodScore <= -0.2) reasons.push("market_mood_headwind");
  if (finalSignal === "BUY") reasons.push("fusion_score_above_buy_threshold");
  if (finalSignal === "SELL") reasons.push("fusion_score_below_sell_threshold");
  if (finalSignal === "HOLD") reasons.push("fusion_score_neutral");

  return {
    final_signal: finalSignal,
    final_confidence: finalConfidence,
    quant_signal: quant?.signal || quant?.quant_signal || "HOLD",
    quant_confidence: quant?.confidence ?? (quantScore === 0 ? 0 : 0.5),
    sentiment_score: sentimentScore,
    market_mood_score: marketMoodScore,
    reasons,
    raw_score: finalScore,
  };
}

function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const dt = new Date(value * 1000);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function normalizeSource(source) {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    return source.name || source.title || "unknown";
  }
  return "unknown";
}

function tickerToNewsToken(symbol) {
  if (!symbol) return "";
  const upper = String(symbol).trim().toUpperCase();
  const base = upper.split(".")[0];
  if (!base) return "";
  return base.replace(/^0+(\d)/, "$1");
}

function filterSymbolRelevantArticles(items, symbol) {
  if (!Array.isArray(items) || !symbol) return Array.isArray(items) ? items : [];
  const token = tickerToNewsToken(symbol);
  if (!token) return items;

  const filtered = items.filter((item) => {
    const title = String(item?.title || "").toUpperCase();
    const summary = String(item?.summary || "").toUpperCase();
    const haystack = `${title} ${summary}`;
    return haystack.includes(token);
  });

  // Keep original list if no symbol-relevant rows are found.
  return filtered.length > 0 ? filtered : items;
}

function normalizeArticles(items, provider) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      title: String(item?.title || item?.headline || ""),
      summary: String(item?.summary || item?.description || item?.snippet || ""),
      source: normalizeSource(item?.source || item?.publisher || item?.site),
      published_at:
        item?.published_at ||
        item?.publishedAt ||
        toIsoDate(item?.datetime) ||
        toIsoDate(item?.time_published) ||
        toIsoDate(item?.time) ||
        "",
      url: String(item?.url || item?.link || ""),
      provider: String(provider || "unknown"),
    }))
    .filter((item) => item.title || item.url);
}

async function fetchOpenbbNews(symbol) {
  const pythonExecutable = process.env.PYTHON_EXECUTABLE || "python";
  const scriptPath = process.env.OPENBB_NEWS_SCRIPT || "openbb_news_service.py";
  const args = [scriptPath, symbol || "LATEST"];
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
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        resolve({ ok: true, data: parsed, stderr });
      } catch (e) {
        resolve({ ok: false, error: "invalid_json", raw: stdout, stderr });
      }
    });
  });
}

function buildDateRange(hours) {
  const end = new Date();
  const start = new Date(end);
  start.setHours(start.getHours() - hours);
  const toIso = (d) => d.toISOString().slice(0, 10);
  return { from: toIso(start), to: toIso(end) };
}

async function fetchFinnhubNews(symbol, lookbackHours) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "FINNHUB_API_KEY missing" };
  }
  const { from, to } = buildDateRange(lookbackHours);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(
    symbol
  )}&from=${from}&to=${to}&token=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, error: `Finnhub HTTP ${res.status}` };
  }
  const data = await res.json();
  return { ok: true, data };
}

async function fetchNewsApi(symbol, lookbackHours) {
  const apiKey = process.env.NEWSAPI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "NEWSAPI_API_KEY missing" };
  }
  const { from } = buildDateRange(lookbackHours);
  const url =
    "https://newsapi.org/v2/everything?" +
    new URLSearchParams({
      q: symbol || "markets",
      language: "en",
      pageSize: "10",
      sortBy: "publishedAt",
      from,
    }).toString();
  const res = await fetch(url, {
    headers: { "X-Api-Key": apiKey },
  });
  if (!res.ok) {
    return { ok: false, error: `NewsAPI HTTP ${res.status}` };
  }
  const data = await res.json();
  return { ok: true, data: data.articles || [] };
}

async function newsFetch({ symbol, lookbackHours }) {
  const key = `news_fetch:${symbol || "LATEST"}:${lookbackHours || 24}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const warnings = [];

  const openbb = await fetchOpenbbNews(symbol);
  if (openbb.ok && Array.isArray(openbb.data?.articles) && openbb.data.articles.length > 0) {
    const normalized = normalizeArticles(openbb.data.articles, "openbb");
    const relevant = filterSymbolRelevantArticles(normalized, symbol);
    const result = {
      symbol: symbol || openbb.data.symbol || "LATEST",
      articles: relevant,
      provider_chain: ["openbb"],
      warnings,
    };
    cacheSet(key, result);
    return result;
  }
  if (!openbb.ok) {
    warnings.push("openbb_error");
  } else {
    warnings.push("openbb_empty");
  }

  const lookback = lookbackHours || 24;
  const fallbackLookback = Math.max(lookback, 72);

  if (symbol) {
    const finnhub = await fetchFinnhubNews(symbol, lookback);
    const finnhubItems = finnhub.ok ? filterSymbolRelevantArticles(normalizeArticles(finnhub.data, "finnhub"), symbol) : [];
    if (finnhubItems.length > 0) {
      const result = {
        symbol,
        articles: finnhubItems,
        provider_chain: ["openbb", "finnhub"],
        warnings,
      };
      cacheSet(key, result);
      return result;
    }
    warnings.push(finnhub.ok ? "finnhub_empty" : finnhub.error);
  }

  const newsApi = await fetchNewsApi(symbol, fallbackLookback);
  const newsApiItems = newsApi.ok ? filterSymbolRelevantArticles(normalizeArticles(newsApi.data, "newsapi"), symbol) : [];
  if (newsApiItems.length > 0) {
    const result = {
      symbol: symbol || "LATEST",
      articles: newsApiItems,
      provider_chain: ["openbb", "newsapi"],
      warnings,
    };
    cacheSet(key, result);
    return result;
  }
  warnings.push(newsApi.ok ? "newsapi_empty" : newsApi.error);

  const result = {
    symbol: symbol || "LATEST",
    articles: [],
    provider_chain: ["openbb", "finnhub", "newsapi"],
    warnings,
  };
  cacheSet(key, result);
  return result;
}

const server = new McpServer({
  name: "news-sentiment-server",
  version: "0.1.0",
});

server.registerTool(
  "news_fetch",
  {
    title: "News fetch (OpenBB primary, Finnhub/NewsAPI fallback)",
    description: "Fetch recent news for a symbol with provider fallback.",
    inputSchema: z.object({
      symbol: z.string().optional().describe("Ticker symbol, optional"),
      // TODO: market is accepted but not yet used in provider queries.
      market: z.string().optional().describe("Market, optional"),
      lookbackHours: z.number().optional().describe("Lookback window in hours"),
    }),
  },
  async ({ symbol, lookbackHours }) => {
    const result = await newsFetch({ symbol, lookbackHours });
    return {
      content: [
        {
          type: "text",
          text: `News fetched for ${result.symbol}. Articles=${result.articles.length}.`,
        },
      ],
      structuredContent: {
        symbol: result.symbol,
        articles: result.articles,
        provider_chain: result.provider_chain,
        warnings: result.warnings,
      },
    };
  }
);

async function fetchAlphaVantageSentiment(symbol) {
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "ALPHAVANTAGE_API_KEY missing" };
  }
  const url =
    "https://www.alphavantage.co/query?" +
    new URLSearchParams({
      function: "NEWS_SENTIMENT",
      tickers: symbol || "",
      limit: "50",
      apikey: apiKey,
    }).toString();
  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, error: `AlphaVantage HTTP ${res.status}` };
  }
  const data = await res.json();
  if (!Array.isArray(data.feed)) {
    return { ok: false, error: data?.Information || data?.Note || "feed_missing", raw: data };
  }
  return { ok: true, data };
}

function computeSentimentFromAlpha(data) {
  const feed = data.feed || [];
  if (feed.length === 0) {
    return { score: 0, label: "neutral", confidence: 0, drivers: [] };
  }
  let total = 0;
  let weightSum = 0;
  const drivers = new Map();

  for (const item of feed) {
    const score = safeNumber(item?.overall_sentiment_score);
    const weight = safeNumber(item?.relevance_score) ?? 1;
    if (score !== null) {
      total += score * weight;
      weightSum += weight;
    }
    const topics = Array.isArray(item?.topics) ? item.topics : [];
    for (const t of topics) {
      const topic = t?.topic || t?.name;
      if (!topic) continue;
      drivers.set(topic, (drivers.get(topic) || 0) + 1);
    }
  }

  const avg = weightSum > 0 ? total / weightSum : 0;
  const label = sentimentLabel(avg);
  const confidence = Math.min(1, Math.abs(avg));
  const topDrivers = Array.from(drivers.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic]) => topic);

  return { score: avg, label, confidence, drivers: topDrivers };
}

async function fetchLlmSentiment(symbol, articles) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY missing" };
  }

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a financial sentiment classifier. Return JSON only with keys: sentiment_score, sentiment_label, confidence, emotion_label, top_drivers.",
      },
      {
        role: "user",
        content: JSON.stringify({
          symbol: symbol || "",
          articles: (articles || []).slice(0, 8),
        }),
      },
    ],
    temperature: 0,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    return { ok: false, error: `OpenAI HTTP ${res.status}` };
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    return { ok: false, error: "llm_invalid_json", raw: content };
  }
  try {
    return { ok: true, data: JSON.parse(match[0]) };
  } catch (e) {
    return { ok: false, error: "llm_parse_error", raw: content };
  }
}

server.registerTool(
  "news_sentiment",
  {
    title: "News sentiment (Alpha Vantage primary, LLM fallback)",
    description: "Compute sentiment from news using Alpha Vantage or LLM fallback.",
    inputSchema: z.object({
      symbol: z.string().optional().describe("Ticker symbol"),
      market: z.string().optional().describe("Market, optional"),
      articles: z
        .array(z.record(z.any()))
        .optional()
        .describe("Optional normalized articles"),
    }),
  },
  async ({ symbol, articles }) => {
    const key = `news_sentiment:${symbol || "LATEST"}`;
    const cached = cacheGet(key);
    if (cached) {
      return {
        content: [
          {
            type: "text",
            text: `Sentiment cached for ${symbol || "LATEST"}.`,
          },
        ],
        structuredContent: cached,
      };
    }

    const warnings = [];
    const alpha = await fetchAlphaVantageSentiment(symbol || "");
    if (alpha.ok) {
      const { score, label, confidence, drivers } = computeSentimentFromAlpha(alpha.data);
      const result = {
        symbol: symbol || "LATEST",
        sentiment_score: score,
        sentiment_label: label,
        confidence,
        emotion_label: label === "positive" ? "bullish" : label === "negative" ? "bearish" : "neutral",
        top_drivers: drivers,
        provider: "alphavantage",
        raw: { feed_count: alpha.data.feed.length },
        warnings,
      };
      cacheSet(key, result);
      return {
        content: [
          {
            type: "text",
            text: `Sentiment computed via Alpha Vantage for ${result.symbol}.`,
          },
        ],
        structuredContent: result,
      };
    }
    warnings.push(alpha.error || "alphavantage_failed");

    let normalizedArticles = Array.isArray(articles) ? articles : [];
    if (normalizedArticles.length === 0) {
      const fetched = await newsFetch({ symbol, lookbackHours: 24 });
      normalizedArticles = fetched.articles || [];
      if (fetched.warnings?.length) {
        warnings.push(...fetched.warnings);
      }
    }

    const llm = await fetchLlmSentiment(symbol || "", normalizedArticles);
    if (llm.ok) {
      const score = safeNumber(llm.data.sentiment_score) ?? 0;
      const label = llm.data.sentiment_label || sentimentLabel(score);
      const confidence = safeNumber(llm.data.confidence) ?? Math.min(1, Math.abs(score));
      const result = {
        symbol: symbol || "LATEST",
        sentiment_score: score,
        sentiment_label: label,
        confidence,
        emotion_label: llm.data.emotion_label || (label === "positive" ? "bullish" : label === "negative" ? "bearish" : "neutral"),
        top_drivers: Array.isArray(llm.data.top_drivers) ? llm.data.top_drivers : [],
        provider: "llm",
        raw: { model: process.env.OPENAI_MODEL || "gpt-4.1-mini" },
        warnings,
      };
      cacheSet(key, result);
      return {
        content: [
          {
            type: "text",
            text: `Sentiment computed via LLM for ${result.symbol}.`,
          },
        ],
        structuredContent: result,
      };
    }

    const fallback = {
      symbol: symbol || "LATEST",
      sentiment_score: 0,
      sentiment_label: "neutral",
      confidence: 0,
      emotion_label: "neutral",
      top_drivers: [],
      provider: "none",
      raw: {},
      warnings: [...warnings, llm.error || "llm_failed"],
    };
    cacheSet(key, fallback);
    return {
      content: [
        {
          type: "text",
          text: `Sentiment fallback (neutral) for ${fallback.symbol}.`,
        },
      ],
      structuredContent: fallback,
    };
  }
);

server.registerTool(
  "market_mood",
  {
    title: "Market mood aggregation",
    description: "Aggregate recent news into market mood score, label, and trend.",
    inputSchema: z.object({
      symbol: z.string().optional().describe("Ticker symbol"),
      market: z.string().optional().describe("Market, optional"),
      days: z.number().optional().describe("Window in days (default 7)"),
    }),
  },
  async ({ symbol, days }) => {
    const windowDays = days || 7;
    const lookbackHours = windowDays * 24;
    const warnings = [];

    const news = await newsFetch({ symbol, lookbackHours });
    const articles = Array.isArray(news.articles) ? news.articles : [];
    if (news.warnings?.length) warnings.push(...news.warnings);

    if (articles.length < 2) {
      return {
        content: [
          {
            type: "text",
            text: `Market mood neutral for ${symbol || "LATEST"} (insufficient data).`,
          },
        ],
        structuredContent: {
          market_mood_score: 0,
          market_mood_label: "neutral",
          trend: "stable",
          provider: "none",
          raw: { warnings: [...warnings, "insufficient_data"] },
        },
      };
    }

    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const dated = articles
      .map((a) => ({ ...a, ts: a.published_at ? Date.parse(a.published_at) : NaN }))
      .filter((a) => Number.isFinite(a.ts) && a.ts >= cutoff)
      .sort((a, b) => b.ts - a.ts);

    if (dated.length < 2) {
      return {
        content: [
          {
            type: "text",
            text: `Market mood neutral for ${symbol || "LATEST"} (window empty).`,
          },
        ],
        structuredContent: {
          market_mood_score: 0,
          market_mood_label: "neutral",
          trend: "stable",
          provider: "none",
          raw: { warnings: [...warnings, "window_empty"] },
        },
      };
    }

    const midpoint = Math.max(1, Math.floor(dated.length / 2));
    const newer = dated.slice(0, midpoint);
    const older = dated.slice(midpoint);

    const newerSent = await fetchLlmSentiment(symbol || "", newer);
    const olderSent = await fetchLlmSentiment(symbol || "", older);

    if (!newerSent.ok) warnings.push(newerSent.error || "newer_segment_failed");
    if (!olderSent.ok) warnings.push(olderSent.error || "older_segment_failed");

    const newerScore = newerSent.ok ? clampScore(newerSent.data?.sentiment_score ?? 0) : null;
    const olderScore = olderSent.ok ? clampScore(olderSent.data?.sentiment_score ?? 0) : null;

    if (newerScore == null && olderScore == null) {
      return {
        content: [
          {
            type: "text",
            text: `Market mood neutral for ${symbol || "LATEST"} (no sentiment).`,
          },
        ],
        structuredContent: {
          market_mood_score: 0,
          market_mood_label: "neutral",
          trend: "stable",
          provider: "none",
          raw: { warnings: [...warnings, "no_sentiment"] },
        },
      };
    }

    const moodScore =
      newerScore != null && olderScore != null
        ? clampScore((newerScore + olderScore) / 2)
        : clampScore(newerScore ?? olderScore ?? 0);

    const delta =
      newerScore != null && olderScore != null ? newerScore - olderScore : 0;

    return {
      content: [
        {
          type: "text",
          text: `Market mood computed for ${symbol || "LATEST"}.`,
        },
      ],
      structuredContent: {
        market_mood_score: moodScore,
        market_mood_label: labelMarketMood(moodScore),
        trend: computeTrend(delta),
        provider: newerSent.ok || olderSent.ok ? "llm" : "none",
        raw: {
          warnings,
          window_days: windowDays,
          article_count: dated.length,
          delta,
        },
      },
    };
  }
);

server.registerTool(
  "trade_fusion",
  {
    title: "Trade fusion (deterministic)",
    description: "Fuse quant, sentiment, and market mood into final signal.",
    inputSchema: z.object({
      quant: z.record(z.any()).optional(),
      sentiment: z.record(z.any()).optional(),
      marketMood: z.record(z.any()).optional(),
    }),
  },
  async ({ quant, sentiment, marketMood }) => {
    const fused = fuseTradeSignals(quant, sentiment, marketMood);
    return {
      content: [
        {
          type: "text",
          text: `Trade fusion result: ${fused.final_signal}.`,
        },
      ],
      structuredContent: fused,
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP news-sentiment server:", err);
  process.exit(1);
});
