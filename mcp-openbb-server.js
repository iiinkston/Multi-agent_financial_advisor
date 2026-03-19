#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";

// ====== PROVIDER STRATEGY ======

// Providers supported by OpenBB's equity quote route
const QUOTE_PROVIDERS = [
  "yfinance",
  "fmp",
  "intrinio",
  "tiingo",
  "polygon",
  "tradier",
  "tmx",
  "alpha_vantage",
];

// Providers supported for equity historical prices
const HISTORICAL_PROVIDERS = [
  "yfinance",
  "stooq",
  "fmp",
  "intrinio",
  "tiingo",
  "polygon",
  "tradier",
  "tmx",
  "alpha_vantage",
];

const DEFAULT_QUOTE_PROVIDER = "yfinance";
const DEFAULT_HIST_PROVIDER = "yfinance";
const HISTORICAL_FALLBACK_FREE_PROVIDER = "stooq";

function validateProviderFor(
  provider,
  allowedProviders,
  defaultProvider,
  kindLabel,
) {
  const chosen = provider || defaultProvider;
  if (!allowedProviders.includes(chosen)) {
    return {
      ok: false,
      provider: chosen,
      error: `Unsupported provider "${chosen}" for ${kindLabel}. Allowed providers: ${allowedProviders.join(
        ", ",
      )}.`,
    };
  }
  return { ok: true, provider: chosen };
}

// ====== PYTHON / OPENBB BRIDGE ======

function buildPythonSnippet() {
  // This script reads [action, jsonArgs] from argv and prints a single JSON object to stdout.
  return `
import sys
import json

def to_serializable(obj):
    try:
        # Prefer OBBject .to_df() / .to_dataframe()
        if hasattr(obj, "to_df"):
            df = obj.to_df()
            return {"dataframe": df.to_dict(orient="records")}
        if hasattr(obj, "to_dataframe"):
            df = obj.to_dataframe()
            return {"dataframe": df.to_dict(orient="records")}
    except Exception:
        pass

    # Generic fallbacks
    try:
        if hasattr(obj, "results"):
            return {"results": obj.results}
    except Exception:
        pass

    try:
        return obj.model_dump()
    except Exception:
        pass

    try:
        return dict(obj)
    except Exception:
        pass

    if hasattr(obj, "__dict__"):
        return obj.__dict__

    return obj


def main():
    try:
        from openbb import obb
    except ImportError as e:
        json.dump(
            {
                "error": "Python package 'openbb' is not installed. Install via: pip install openbb",
                "details": str(e),
                "missing_dependency": "openbb",
            },
            sys.stdout,
            default=str,
        )
        return

    if len(sys.argv) < 3:
        json.dump(
            {
                "error": "Missing arguments for OpenBB bridge. Expected: action and JSON payload.",
            },
            sys.stdout,
        )
        return

    action = sys.argv[1]
    try:
        params = json.loads(sys.argv[2])
    except Exception as e:
        json.dump(
            {
                "error": "Invalid JSON arguments passed from Node.",
                "details": str(e),
            },
            sys.stdout,
        )
        return

    try:
        if action == "equity_quote":
            result = obb.equity.price.quote(
                symbol=params.get("symbol"),
                provider=params.get("provider"),
            )
        elif action == "equity_price_historical":
            kwargs = {
                "symbol": params.get("symbol"),
                "provider": params.get("provider"),
            }
            if params.get("start_date"):
                kwargs["start_date"] = params.get("start_date")
            if params.get("end_date"):
                kwargs["end_date"] = params.get("end_date")
            if params.get("interval"):
                kwargs["interval"] = params.get("interval")
            result = obb.equity.price.historical(**kwargs)
        elif action == "equity_search":
            result = obb.equity.search(
                query=params.get("query"),
                provider=params.get("provider"),
            )
        else:
            json.dump(
                {
                    "error": "Unknown OpenBB action.",
                    "action": action,
                },
                sys.stdout,
            )
            return

        serializable = to_serializable(result)
        json.dump(serializable, sys.stdout, default=str)
    except Exception as e:
        json.dump(
            {
                "error": "Exception while executing OpenBB action.",
                "action": action,
                "details": str(e),
            },
            sys.stdout,
            default=str,
        )


if __name__ == "__main__":
    main()
`;
}

async function runOpenBB(action, payload) {
  const pythonExecutable = process.env.PYTHON_EXECUTABLE || "python";

  const args = ["-c", buildPythonSnippet(), action, JSON.stringify(payload)];

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
      resolve({
        ok: false,
        error: `Failed to start Python process with executable "${pythonExecutable}". Make sure Python is installed and reachable. Underlying error: ${String(
          err,
        )}`,
        stderr,
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          error: `Python process exited with code ${code}. stderr: ${stderr}`,
        });
        return;
      }

      if (!stdout.trim()) {
        resolve({
          ok: false,
          error:
            "Python process returned empty output. Ensure OpenBB is correctly installed and configured.",
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        if (parsed && parsed.error) {
          resolve({
            ok: false,
            error: parsed.error,
            data: parsed,
          });
        } else {
          resolve({
            ok: true,
            data: parsed,
          });
        }
      } catch (e) {
        resolve({
          ok: false,
          error:
            "Failed to parse JSON from Python OpenBB bridge. Ensure the script prints only JSON to stdout.",
          details: String(e),
          raw: stdout,
        });
      }
    });
  });
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Normalize quote result into our schema
function normalizeQuote({ symbol, provider, data }) {
  let row = null;

  if (Array.isArray(data?.dataframe) && data.dataframe.length > 0) {
    row = data.dataframe[0];
  } else if (Array.isArray(data?.results) && data.results.length > 0) {
    row = data.results[0];
  } else if (data && typeof data === "object") {
    row = data;
  }

  const price = row
    ? firstDefined(
        row.last_price,
        row.last,
        row.close,
        row.c,
        row.price,
        row.current,
      )
    : null;

  const open = row ? firstDefined(row.open, row.o) : null;
  const high = row ? firstDefined(row.high, row.h) : null;
  const low = row ? firstDefined(row.low, row.l) : null;
  const prevClose = row
    ? firstDefined(row.prev_close, row.previous_close, row.pc)
    : null;
  const currency = row ? firstDefined(row.currency, row.curr) : null;

  const timestamp =
    (row && firstDefined(row.datetime, row.timestamp, row.date)) ||
    new Date().toISOString();

  return {
    symbol,
    provider,
    timestamp: String(timestamp),
    price: price != null ? Number(price) : null,
    open: open != null ? Number(open) : null,
    high: high != null ? Number(high) : null,
    low: low != null ? Number(low) : null,
    prevClose: prevClose != null ? Number(prevClose) : null,
    currency: currency != null ? String(currency) : null,
    raw: data || {},
  };
}

// Normalize historical price data
function normalizeHistorical({ symbol, provider, start_date, end_date, interval, data }) {
  const records = Array.isArray(data?.dataframe)
    ? data.dataframe
    : Array.isArray(data?.results)
      ? data.results
      : [];

  const rows = records.map((r) => ({
    date: String(
      firstDefined(r.date, r.datetime, r.timestamp, r.index) ??
        new Date().toISOString(),
    ),
    open: r.open != null ? Number(r.open) : null,
    high: r.high != null ? Number(r.high) : null,
    low: r.low != null ? Number(r.low) : null,
    close: r.close != null ? Number(r.close) : null,
    volume: r.volume != null ? Number(r.volume) : null,
  }));

  return {
    symbol,
    provider,
    start_date: start_date || null,
    end_date: end_date || null,
    interval,
    rows,
    raw: data || {},
  };
}

// Normalize search result
function normalizeSearch({ provider, query, data }) {
  let results = [];

  if (Array.isArray(data)) {
    results = data;
  } else if (Array.isArray(data?.results)) {
    results = data.results;
  } else if (Array.isArray(data?.dataframe)) {
    results = data.dataframe;
  } else if (data && typeof data === "object") {
    results = [data];
  }

  return {
    provider,
    query,
    results,
    raw: data || {},
  };
}

function normalizeSymbol(symbol) {
  if (typeof symbol === "string" && symbol.endsWith(".SH")) {
    return symbol.replace(".SH", ".SS");
  }
  return symbol;
}

// ====== MCP SERVER SETUP ======

const server = new McpServer({
  name: "openbb-server",
  version: "0.1.0",
});

// 1) equity_quote
server.registerTool(
  "equity_quote",
  {
    title: "Equity real-time quote via OpenBB",
    description:
      "Fetch a normalized real-time equity quote using OpenBB providers (default: yfinance).",
    inputSchema: z.object({
      symbol: z
        .string()
        .describe("Ticker symbol, e.g. AAPL, TSLA, NVDA, 700.HK"),
      provider: z
        .string()
        .optional()
        .describe(
          `Data provider to use. Default "${DEFAULT_QUOTE_PROVIDER}". Allowed: ${QUOTE_PROVIDERS.join(
            ", ",
          )}.`,
        ),
    }),
  },
  async ({ symbol, provider }) => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const validation = validateProviderFor(
      provider,
      QUOTE_PROVIDERS,
      DEFAULT_QUOTE_PROVIDER,
      "equity_quote",
    );
    if (!validation.ok) {
      const errorMessage = validation.error;
      return {
        content: [
          {
            type: "text",
            text: errorMessage,
          },
        ],
        structuredContent: {
          error: errorMessage,
          symbol: normalizedSymbol,
          provider: validation.provider,
          raw: {},
        },
      };
    }

    const chosenProvider = validation.provider;

    // Try primary quote provider first, then a single paid fallback if configured
    const attempts = [chosenProvider];
    // For quotes, do NOT fallback to stooq (not supported by the quote route)
    if (chosenProvider === DEFAULT_QUOTE_PROVIDER) {
      const quoteFallback = QUOTE_PROVIDERS.includes("fmp")
        ? "fmp"
        : QUOTE_PROVIDERS.includes("tradier")
          ? "tradier"
          : null;
      if (quoteFallback) {
        attempts.push(quoteFallback);
      }
    }

    let lastError = null;
    let normalized = null;
    let usedProvider = chosenProvider;

    for (const attemptProvider of attempts) {
      const result = await runOpenBB("equity_quote", {
        symbol: normalizedSymbol,
        provider: attemptProvider,
      });

      if (result.ok) {
        usedProvider = attemptProvider;
        normalized = normalizeQuote({
          symbol: normalizedSymbol,
          provider: attemptProvider,
          data: result.data,
        });
        break;
      } else {
        const details =
          result.details ?? (result.data && result.data.details) ?? undefined;
        lastError = {
          provider: attemptProvider,
          error: result.error,
          details,
        };
      }
    }

    // If direct quote failed, attempt to derive a fallback quote from recent historical data
    if (!normalized) {
      const today = new Date();
      const endDate = formatDate(today);
      const start = new Date(today);
      start.setDate(start.getDate() - 21); // ~last 10 trading days
      const startDate = formatDate(start);

      // Use the chosen quote provider if it also supports historical, otherwise default historical provider
      const histProvider = HISTORICAL_PROVIDERS.includes(chosenProvider)
        ? chosenProvider
        : DEFAULT_HIST_PROVIDER;

      const histResult = await runOpenBB("equity_price_historical", {
        symbol: normalizedSymbol,
        provider: histProvider,
        start_date: startDate,
        end_date: endDate,
        interval: "1d",
      });

      if (histResult.ok) {
        const histNormalized = normalizeHistorical({
          symbol: normalizedSymbol,
          provider: histProvider,
          start_date: startDate,
          end_date: endDate,
          interval: "1d",
          data: histResult.data,
        });

        const rows = histNormalized.rows || [];
        if (rows.length > 0) {
          const lastRow = rows[rows.length - 1];
          const prevRow = rows.length > 1 ? rows[rows.length - 2] : null;

          const fallbackPrice =
            lastRow.close != null ? Number(lastRow.close) : null;
          const fallbackOpen =
            lastRow.open != null ? Number(lastRow.open) : null;
          const fallbackHigh =
            lastRow.high != null ? Number(lastRow.high) : null;
          const fallbackLow =
            lastRow.low != null ? Number(lastRow.low) : null;
          const fallbackPrevClose =
            prevRow && prevRow.close != null ? Number(prevRow.close) : null;

          const fallbackQuote = {
            symbol: normalizedSymbol,
            provider: histProvider,
            timestamp: String(lastRow.date),
            price: fallbackPrice,
            open: fallbackOpen,
            high: fallbackHigh,
            low: fallbackLow,
            prevClose: fallbackPrevClose,
            currency: null,
            warnings: ["quote_failed_fallback_to_historical_close"],
            raw: {
              quoteError: lastError || {},
              historical: histNormalized.raw || {},
            },
          };

          return {
            content: [
              {
                type: "text",
                text: `Quote for ${fallbackQuote.symbol} via ${fallbackQuote.provider} derived from latest historical close: price=${fallbackQuote.price}, open=${fallbackQuote.open}, high=${fallbackQuote.high}, low=${fallbackQuote.low}, prevClose=${fallbackQuote.prevClose}`,
              },
            ],
            structuredContent: fallbackQuote,
          };
        }
      }

      const errorMessage =
        lastError?.error ||
        "Failed to fetch quote or derive from historical data using OpenBB providers.";
      return {
        content: [
          {
            type: "text",
            text: `Error fetching quote for ${normalizedSymbol}: ${errorMessage}`,
          },
        ],
        structuredContent: {
          error: errorMessage,
          symbol: normalizedSymbol,
          provider: usedProvider,
          raw: {
            quoteError: lastError || {},
            historicalError: histResult && !histResult.ok ? histResult : {},
          },
        },
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Quote for ${normalized.symbol} via ${normalized.provider}: price=${normalized.price}, open=${normalized.open}, high=${normalized.high}, low=${normalized.low}, prevClose=${normalized.prevClose}`,
        },
      ],
      structuredContent: normalized,
    };
  },
);

// 2) equity_price_historical
server.registerTool(
  "equity_price_historical",
  {
    title: "Equity historical prices via OpenBB",
    description:
      "Fetch normalized historical OHLCV price data for an equity using OpenBB providers (default: yfinance).",
    inputSchema: z.object({
      symbol: z
        .string()
        .describe("Ticker symbol, e.g. AAPL, TSLA, NVDA, 700.HK"),
      provider: z
        .string()
        .optional()
        .describe(
          `Data provider to use. Default "${DEFAULT_HIST_PROVIDER}". Allowed: ${HISTORICAL_PROVIDERS.join(
            ", ",
          )}.`,
        ),
      start_date: z
        .string()
        .optional()
        .describe("Start date in YYYY-MM-DD format (inclusive)."),
      end_date: z
        .string()
        .optional()
        .describe("End date in YYYY-MM-DD format (inclusive)."),
      interval: z
        .string()
        .optional()
        .default("1d")
        .describe(
          'Bar interval, e.g. "1d" for daily. Provider-specific options may apply.',
        ),
    }),
  },
  async ({ symbol, provider, start_date, end_date, interval = "1d" }) => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const validation = validateProviderFor(
      provider,
      HISTORICAL_PROVIDERS,
      DEFAULT_HIST_PROVIDER,
      "equity_price_historical",
    );
    if (!validation.ok) {
      const errorMessage = validation.error;
      return {
        content: [
          {
            type: "text",
            text: errorMessage,
          },
        ],
        structuredContent: {
          error: errorMessage,
          symbol: normalizedSymbol,
          provider: validation.provider,
          start_date: start_date || null,
          end_date: end_date || null,
          interval,
          rows: [],
          raw: {},
        },
      };
    }

    const chosenProvider = validation.provider;

    // Try primary provider first, then fallback once if it fails
    const attempts = [chosenProvider];
    if (
      chosenProvider === DEFAULT_HIST_PROVIDER &&
      HISTORICAL_FALLBACK_FREE_PROVIDER &&
      HISTORICAL_PROVIDERS.includes(HISTORICAL_FALLBACK_FREE_PROVIDER)
    ) {
      attempts.push(HISTORICAL_FALLBACK_FREE_PROVIDER);
    }

    let lastError = null;
    let normalized = null;
    let usedProvider = chosenProvider;

    for (const attemptProvider of attempts) {
      const result = await runOpenBB("equity_price_historical", {
        symbol: normalizedSymbol,
        provider: attemptProvider,
        start_date,
        end_date,
        interval,
      });

      if (result.ok) {
        usedProvider = attemptProvider;
        normalized = normalizeHistorical({
          symbol: normalizedSymbol,
          provider: attemptProvider,
          start_date,
          end_date,
          interval,
          data: result.data,
        });
        break;
      } else {
        const details =
          result.details ?? (result.data && result.data.details) ?? undefined;
        lastError = {
          provider: attemptProvider,
          error: result.error,
          details,
        };
      }
    }

    if (!normalized) {
      const errorMessage =
        lastError?.error ||
        "Failed to fetch historical prices from all attempted OpenBB providers.";
      return {
        content: [
          {
            type: "text",
          text: `Error fetching historical prices for ${normalizedSymbol}: ${errorMessage}`,
          },
        ],
        structuredContent: {
          error: errorMessage,
        symbol: normalizedSymbol,
          provider: usedProvider,
          start_date: start_date || null,
          end_date: end_date || null,
          interval,
          rows: [],
          raw: lastError || {},
        },
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Historical prices for ${normalized.symbol} via ${normalized.provider} from ${normalized.start_date} to ${normalized.end_date} (${normalized.interval}). Rows=${normalized.rows.length}.`,
        },
      ],
      structuredContent: normalized,
    };
  },
);

// 3) equity_search
server.registerTool(
  "equity_search",
  {
    title: "Equity search via OpenBB",
    description:
      "Search for equities (by symbol or name) using OpenBB providers (default: yfinance).",
    inputSchema: z.object({
      query: z.string().describe("Search query, e.g. company name or symbol."),
      provider: z
        .string()
        .optional()
        .describe(
          `Data provider to use. Default "${DEFAULT_HIST_PROVIDER}". Allowed: ${HISTORICAL_PROVIDERS.join(
            ", ",
          )}.`,
        ),
    }),
  },
  async ({ query, provider }) => {
    const validation = validateProviderFor(
      provider,
      HISTORICAL_PROVIDERS,
      DEFAULT_HIST_PROVIDER,
      "equity_search",
    );
    if (!validation.ok) {
      const errorMessage = validation.error;
      return {
        content: [
          {
            type: "text",
            text: errorMessage,
          },
        ],
        structuredContent: {
          error: errorMessage,
          provider: validation.provider,
          query,
          results: [],
          raw: {},
        },
      };
    }

    const chosenProvider = validation.provider;

    // Try primary provider first, then fallback once if it fails
    const attempts = [chosenProvider];
    if (
      chosenProvider === DEFAULT_HIST_PROVIDER &&
      HISTORICAL_FALLBACK_FREE_PROVIDER &&
      HISTORICAL_PROVIDERS.includes(HISTORICAL_FALLBACK_FREE_PROVIDER)
    ) {
      attempts.push(HISTORICAL_FALLBACK_FREE_PROVIDER);
    }

    let lastError = null;
    let normalized = null;
    let usedProvider = chosenProvider;

    for (const attemptProvider of attempts) {
      const result = await runOpenBB("equity_search", {
        query,
        provider: attemptProvider,
      });

      if (result.ok) {
        usedProvider = attemptProvider;
        normalized = normalizeSearch({
          provider: attemptProvider,
          query,
          data: result.data,
        });
        break;
      } else {
        const details =
          result.details ?? (result.data && result.data.details) ?? undefined;
        lastError = {
          provider: attemptProvider,
          error: result.error,
          details,
        };
      }
    }

    if (!normalized) {
      const errorMessage =
        lastError?.error ||
        "Failed to search equities from all attempted OpenBB providers.";
      return {
        content: [
          {
            type: "text",
            text: `Error searching equities for query "${query}": ${errorMessage}`,
          },
        ],
        structuredContent: {
          error: errorMessage,
          provider: usedProvider,
          query,
          results: [],
          raw: lastError || {},
        },
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Equity search via ${normalized.provider} for "${normalized.query}" returned ${normalized.results.length} results.`,
        },
      ],
      structuredContent: normalized,
    };
  },
);

// ====== START SERVER (STDIO) ======

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP openbb-server:", err);
  process.exit(1);
});

