import MCPClient from "./MCPClient.js";

export type AgentState = {
  userQuery: string;
  symbol: string;
  market?: string;
  intent?: string;
  chartVisionAnalysis?: {
    chart_type: "candlestick" | "line" | "bar" | "unknown";
    trend: "bullish" | "bearish" | "sideways" | "unknown";
    patterns: Array<{
      name: string;
      confidence: number;
    }>;
    confidence: number;
    summary: string;
    risk_note: string;
  };
  quant?: {
    signal: "BUY" | "SELL" | "HOLD";
    confidence: number;
    position?: number;
    raw?: any;
    provider?: string;
  };
  news?: {
    symbol: string;
    articles: Array<{
      title: string;
      summary: string;
      source: string;
      published_at: string;
      url: string;
      provider: string;
    }>;
  };
  sentiment?: {
    symbol: string;
    sentiment_score: number;
    sentiment_label: string;
    confidence: number;
    emotion_label?: string;
    top_drivers?: string[];
    provider?: string;
    raw?: any;
  };
  marketMood?: {
    market_mood_score: number;
    market_mood_label: string;
    trend: string;
    provider?: string;
    raw?: any;
  };
  decision?: {
    final_signal: "BUY" | "SELL" | "HOLD";
    final_confidence: number;
    quant_signal: string;
    quant_confidence: number;
    sentiment_score: number;
    market_mood_score: number;
    reasons: string[];
    raw_score?: number;
  };
  trace?: {
    steps?: string[];
    providers?: string[];
    warnings?: string[];
  };
  errors?: string[];
};

const MARKET_ALIAS_MAP: Record<string, string> = {
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

function normalizeMarketAlias(market?: string): string | undefined {
  if (!market) return undefined;
  const key = String(market).trim().toLowerCase();
  if (MARKET_ALIAS_MAP[key]) return MARKET_ALIAS_MAP[key];
  const upper = key.toUpperCase();
  if (["US", "UK", "CN", "SG", "HK"].includes(upper)) return upper;
  return market;
}

function normalizeSymbol(symbol?: string): string {
  return symbol ? symbol.trim().toUpperCase() : "";
}

const NON_TICKER_WORDS = new Set([
  "I",
  "A",
  "AN",
  "THE",
  "BUY",
  "SELL",
  "HOLD",
  "US",
  "UK",
  "CN",
  "HK",
  "SG",
]);

function isReliableTicker(candidate: string): boolean {
  const s = normalizeSymbol(candidate);
  if (!s) return false;
  if (NON_TICKER_WORDS.has(s)) return false;

  // Dot tickers: 600519.SS, 0700.HK, D05.SI, VOD.L
  if (/^[A-Z0-9]{1,6}\.[A-Z]{1,3}$/.test(s)) return true;
  // US-style tickers: AAPL, TSLA, BABA (2-5 letters; exclude single-letter noise)
  if (/^[A-Z]{2,5}$/.test(s)) return true;
  return false;
}

function extractSymbolFromQuery(query: string): string {
  const dotCandidates = Array.from(query.matchAll(/\b[A-Za-z0-9]{1,6}\.[A-Za-z]{1,3}\b/g))
    .map((m) => normalizeSymbol(m[0]))
    .filter(isReliableTicker);
  if (dotCandidates.length > 0) return dotCandidates[0];

  const plainCandidates = Array.from(query.matchAll(/\b[A-Za-z]{1,8}\b/g))
    .map((m) => normalizeSymbol(m[0]))
    .filter(isReliableTicker)
    .sort((a, b) => b.length - a.length);
  if (plainCandidates.length > 0) return plainCandidates[0];

  return "";
}

function extractMarketFromQuery(query: string): string | undefined {
  const lower = query.toLowerCase();
  for (const alias of Object.keys(MARKET_ALIAS_MAP)) {
    if (lower.includes(alias)) return MARKET_ALIAS_MAP[alias];
  }
  return undefined;
}

function inferMarketFromSymbol(symbol: string): string | undefined {
  if (!symbol) return undefined;
  const upper = symbol.toUpperCase();
  if (upper.endsWith(".HK")) return "HK";
  if (upper.endsWith(".SS") || upper.endsWith(".SZ") || upper.endsWith(".SH")) return "CN";
  if (upper.endsWith(".SI")) return "SG";
  if (upper.endsWith(".L") || upper.endsWith(".UK")) return "UK";
  if (/^[A-Z]{1,5}$/.test(upper)) return "US";
  return undefined;
}

function ensureTrace(state: AgentState) {
  if (!state.trace) state.trace = {};
  if (!state.trace.steps) state.trace.steps = [];
  if (!state.trace.providers) state.trace.providers = [];
  if (!state.trace.warnings) state.trace.warnings = [];
}

function addTrace(state: AgentState, step: string, provider?: string, warning?: string) {
  ensureTrace(state);
  state.trace!.steps!.push(step);
  if (provider) state.trace!.providers!.push(provider);
  if (warning) state.trace!.warnings!.push(warning);
}

function addError(state: AgentState, error: string) {
  if (!state.errors) state.errors = [];
  state.errors.push(error);
}

function findClientWithTool(mcpClients: MCPClient[], toolName: string): MCPClient | null {
  return (
    mcpClients.find((client) => client.getTools().some((t) => t.name === toolName)) ||
    null
  );
}

async function callTool(
  mcpClients: MCPClient[],
  toolName: string,
  args: Record<string, any>
) {
  const client = findClientWithTool(mcpClients, toolName);
  if (!client) {
    return { ok: false, error: `tool_not_found:${toolName}` };
  }
  const result = await client.callTool(toolName, args);
  if (!result.success) {
    return { ok: false, error: result.error || `tool_failed:${toolName}` };
  }
  const structured = result.output?.structuredContent ?? null;
  return { ok: true, structured, raw: result.output };
}

function isValidQuant(state: AgentState): boolean {
  const signal = state.quant?.signal;
  return signal === "BUY" || signal === "SELL" || signal === "HOLD";
}

export function initTradingState(
  userQuery: string,
  intent?: string,
  chartVisionAnalysis?: AgentState["chartVisionAnalysis"]
): AgentState {
  const symbol = extractSymbolFromQuery(userQuery);
  const marketFromQuery = extractMarketFromQuery(userQuery);
  const marketFromSymbol = inferMarketFromSymbol(symbol);
  const market = normalizeMarketAlias(marketFromQuery || marketFromSymbol);

  return {
    userQuery,
    symbol: normalizeSymbol(symbol),
    market,
    intent,
    chartVisionAnalysis,
    trace: { steps: [], providers: [], warnings: [] },
    errors: [],
  };
}

export async function quantAgent(state: AgentState, mcpClients: MCPClient[]) {
  addTrace(state, "quant_agent", "quant_signal");
  if (!state.symbol || !state.market) {
    addError(state, "quant_missing_symbol_or_market");
    addTrace(state, "quant_agent", undefined, "quant_missing_symbol_or_market");
    return state;
  }

  const response = await callTool(mcpClients, "quant_signal", {
    market: state.market,
    ticker: state.symbol,
  });

  if (!response.ok) {
    addError(state, response.error || "quant_failed");
    addTrace(state, "quant_agent", undefined, response.error || "quant_failed");
    return state;
  }

  const data = response.structured || {};
  if (data.error) {
    addError(state, data.error);
    addTrace(state, "quant_agent", undefined, data.error);
    return state;
  }

  state.quant = {
    signal: data.signal,
    confidence: Number(data.confidence ?? 0),
    position: data.position,
    provider: data.model_name || "quant_model",
    raw: data,
  };
  return state;
}

export async function newsAgent(state: AgentState, mcpClients: MCPClient[]) {
  addTrace(state, "news_agent", "news_fetch");
  const response = await callTool(mcpClients, "news_fetch", {
    symbol: state.symbol || undefined,
  });
  if (!response.ok) {
    addError(state, response.error || "news_fetch_failed");
    addTrace(state, "news_agent", undefined, response.error || "news_fetch_failed");
    return state;
  }
  const data = response.structured || {};
  state.news = {
    symbol: data.symbol || state.symbol || "LATEST",
    articles: Array.isArray(data.articles) ? data.articles : [],
  };
  if (Array.isArray(data.provider_chain)) {
    data.provider_chain.forEach((p: string) => addTrace(state, "news_provider", p));
  }
  if (Array.isArray(data.warnings)) {
    data.warnings.forEach((w: string) => addTrace(state, "news_warning", undefined, w));
  }
  return state;
}

export async function sentimentAgent(state: AgentState, mcpClients: MCPClient[]) {
  addTrace(state, "sentiment_agent", "news_sentiment");
  const response = await callTool(mcpClients, "news_sentiment", {
    symbol: state.symbol || undefined,
    articles: state.news?.articles || undefined,
  });
  if (!response.ok) {
    addError(state, response.error || "sentiment_failed");
    addTrace(state, "sentiment_agent", undefined, response.error || "sentiment_failed");
    state.sentiment = {
      symbol: state.symbol || "LATEST",
      sentiment_score: 0,
      sentiment_label: "neutral",
      confidence: 0,
      emotion_label: "neutral",
      top_drivers: [],
      provider: "none",
      raw: {},
    };
    return state;
  }
  const data = response.structured || {};
  state.sentiment = {
    symbol: data.symbol || state.symbol || "LATEST",
    sentiment_score: Number(data.sentiment_score ?? 0),
    sentiment_label: data.sentiment_label || "neutral",
    confidence: Number(data.confidence ?? 0),
    emotion_label: data.emotion_label,
    top_drivers: Array.isArray(data.top_drivers) ? data.top_drivers : [],
    provider: data.provider || "unknown",
    raw: data.raw,
  };
  if (Array.isArray(data.warnings)) {
    data.warnings.forEach((w: string) => addTrace(state, "sentiment_warning", undefined, w));
  }
  return state;
}

export async function marketMoodAgent(state: AgentState, mcpClients: MCPClient[]) {
  addTrace(state, "market_mood_agent", "market_mood");
  const response = await callTool(mcpClients, "market_mood", {
    symbol: state.symbol || undefined,
    market: state.market || undefined,
    days: 7,
  });
  if (!response.ok) {
    addError(state, response.error || "market_mood_failed");
    addTrace(state, "market_mood_agent", undefined, response.error || "market_mood_failed");
    state.marketMood = {
      market_mood_score: 0,
      market_mood_label: "neutral",
      trend: "stable",
      provider: "none",
      raw: {},
    };
    return state;
  }
  const data = response.structured || {};
  state.marketMood = {
    market_mood_score: Number(data.market_mood_score ?? 0),
    market_mood_label: data.market_mood_label || "neutral",
    trend: data.trend || "stable",
    provider: data.provider || "unknown",
    raw: data.raw,
  };
  return state;
}

export async function decisionAgent(state: AgentState, mcpClients: MCPClient[]) {
  addTrace(state, "decision_agent", "trade_fusion");
  const response = await callTool(mcpClients, "trade_fusion", {
    quant: state.quant,
    sentiment: state.sentiment,
    marketMood: state.marketMood,
  });
  if (!response.ok) {
    addError(state, response.error || "trade_fusion_failed");
    addTrace(state, "decision_agent", undefined, response.error || "trade_fusion_failed");
    state.decision = {
      final_signal: "HOLD",
      final_confidence: 0,
      quant_signal: state.quant?.signal || "HOLD",
      quant_confidence: state.quant?.confidence ?? 0,
      sentiment_score: state.sentiment?.sentiment_score ?? 0,
      market_mood_score: state.marketMood?.market_mood_score ?? 0,
      reasons: ["fusion_unavailable"],
      raw_score: 0,
    };
    return state;
  }
  state.decision = response.structured || undefined;
  return state;
}

export async function runTradingWorkflow(
  state: AgentState,
  mcpClients: MCPClient[]
): Promise<AgentState> {
  if (!state.symbol) {
    addError(state, "symbol_not_found");
    addTrace(state, "workflow_fallback", undefined, "symbol_not_found");
    state.decision = {
      final_signal: "HOLD",
      final_confidence: 0,
      quant_signal: "HOLD",
      quant_confidence: 0,
      sentiment_score: 0,
      market_mood_score: 0,
      reasons: ["symbol_not_found"],
      raw_score: 0,
    };
    return state;
  }

  await quantAgent(state, mcpClients);
  if (!isValidQuant(state)) {
    state.decision = {
      final_signal: "HOLD",
      final_confidence: 0,
      quant_signal: "HOLD",
      quant_confidence: 0,
      sentiment_score: 0,
      market_mood_score: 0,
      reasons: ["quant_unavailable"],
      raw_score: 0,
    };
    addTrace(state, "decision_fallback", undefined, "quant_unavailable");
    return state;
  }

  await newsAgent(state, mcpClients);
  await sentimentAgent(state, mcpClients);
  await marketMoodAgent(state, mcpClients);
  await decisionAgent(state, mcpClients);
  return state;
}

function formatNumber(value: number | undefined, decimals = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(decimals);
}

export function buildTradingAnswer(state: AgentState): string {
  const decision = state.decision;
  const quant = state.quant;
  const sentiment = state.sentiment;
  const mood = state.marketMood;
  const symbol = state.symbol || "UNKNOWN";
  const market = state.market || "UNKNOWN";

  const lines: string[] = [];
  if (!state.symbol) {
    lines.push(
      "No valid ticker symbol was detected in your request. Please provide a specific symbol such as AAPL, TSLA, 0700.HK, 600519.SS, D05.SI, or VOD.L."
    );
    return lines.join("\n\n");
  }
  if (decision) {
    lines.push(
      `Final signal for ${symbol} (${market}) is ${decision.final_signal} with confidence ${formatNumber(
        decision.final_confidence
      )}.`
    );
  } else {
    lines.push(`Final signal for ${symbol} (${market}) is HOLD with confidence 0.`);
  }

  if (state.chartVisionAnalysis) {
    const cv = state.chartVisionAnalysis;
    lines.push(
      `Chart vision (supplementary) suggests ${cv.trend} trend on a ${cv.chart_type} chart with confidence ${formatNumber(
        cv.confidence
      )}. ${cv.summary} Risk note: ${cv.risk_note}`
    );
  }

  if (quant) {
    lines.push(
      `Quant signal is ${quant.signal} with confidence ${formatNumber(
        quant.confidence
      )} from ${quant.provider || "quant_model"}.`
    );
  } else {
    lines.push(`Quant signal is unavailable, so no model-driven conviction was applied.`);
  }

  if (sentiment) {
    lines.push(
      `News sentiment score is ${formatNumber(sentiment.sentiment_score)} (${sentiment.sentiment_label}) from ${
        sentiment.provider || "unknown"
      }.`
    );
  } else {
    lines.push(`News sentiment is neutral due to missing data.`);
  }

  if (mood) {
    lines.push(
      `Market mood score is ${formatNumber(mood.market_mood_score)} (${mood.market_mood_label}) with trend ${mood.trend}.`
    );
  } else {
    lines.push(`Market mood is neutral due to missing data.`);
  }

  const articles = state.news?.articles || [];
  if (articles.length > 0) {
    const highlights = articles.slice(0, 3).map((a) => {
      const date = a.published_at ? a.published_at.split("T")[0] : "unknown date";
      const source = typeof a.source === "string" ? a.source : "unknown";
      const title = typeof a.title === "string" ? a.title : "Untitled";
      return `${title} (${source}, ${date})`;
    });
    lines.push(`Recent news highlights include: ${highlights.join("; ")}.`);
  }

  const providers = state.trace?.providers || [];
  if (providers.length > 0) {
    lines.push(`Providers used: ${Array.from(new Set(providers)).join(", ")}.`);
  }

  const warnings = state.trace?.warnings || [];
  if (warnings.length > 0) {
    lines.push(`Warnings: ${Array.from(new Set(warnings)).join(", ")}.`);
  }

  const errors = state.errors || [];
  if (errors.length > 0) {
    lines.push(`Errors: ${Array.from(new Set(errors)).join(", ")}.`);
  }

  return lines.join("\n\n");
}
