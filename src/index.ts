// index.ts
import path from "path";
import fs from "fs";
import MCPClient from "./MCPClient.js";
import Agent from "./Agent.js";
import EmbeddingRetrievers from "./embeddingRetrievers.js";
import { logTitle } from "./util.js";
import "dotenv/config";

// ====== CONFIG ======
const currentDir = process.cwd();
const knowledgeDir = path.join(currentDir, "knowledge", "rag_data");

// Ensure knowledge directory exists
if (!fs.existsSync(knowledgeDir)) {
    console.warn(`Knowledge directory not found: ${knowledgeDir}`);
    console.warn(`Creating directory...`);
    fs.mkdirSync(knowledgeDir, { recursive: true });
}

// ====== MCP CLIENTS ======

// 1) Market data tools (OpenBB; MCP server: node mcp-openbb-server.js)
const openbbMcpClient = new MCPClient("openbb-server", "node", ["mcp-openbb-server.js"]);

// Optional legacy Finnhub quote tool (fallback, not primary).
// Only enabled when USE_LEGACY_FINNHUB=true is set in the environment.
const useLegacyFinnhub = process.env.USE_LEGACY_FINNHUB === "true";
const legacyFinnhubMcpClient = useLegacyFinnhub
    ? new MCPClient("legacy-finnhub", "node", ["mcp-stock-server.js"])
    : null;

// 2) Fetch tool
const fetchMcp = new MCPClient("fetch", "uvx", ["mcp-server-fetch"]);

// 3) File system tool
const fileMcp = new MCPClient("file", "npx", [
    "-y",
    "@modelcontextprotocol/server-filesystem",
    currentDir,
]);

// 4) Quant model tool (PPO signal)
const quantMcp = new MCPClient("quant-model", "node", ["mcp-quant-server.js"]);
// 5) News + sentiment tools (MCP)
const newsSentimentMcp = new MCPClient("news-sentiment", "node", ["mcp-news-sentiment-server.js"]);

// ====== SYSTEM PROMPT ======
const systemPrompt = `
You are a senior financial market analyst with institutional-grade expertise in equity research, portfolio analysis, and risk assessment. Your role is to provide evidence-based market analysis using both real-time data tools and historical market knowledge.

=== TOOLS AVAILABLE ===
1. "equity_quote" — real-time equity quote via OpenBB (default provider: yfinance).
2. "equity_price_historical" — historical OHLCV equity prices via OpenBB (default provider: yfinance).
3. "equity_search" — search for equities by symbol or name via OpenBB.
4. "fetch" — fetch online JSON or text from a URL.
5. "file" — read/write file content to disk.
6. "quant_signal" — model-driven trading signal from the PPO quant model.

=== TOOL USAGE STRATEGY ===
Provider strategy:
- Prefer free providers by default: use "yfinance" first.
- For historical data, you may retry once with "stooq" as a free fallback if "yfinance" fails.
- For quotes, you may retry once with a supported paid provider (e.g. "fmp" or "tradier") if "yfinance" fails; do NOT use "stooq" for quotes.

Tool usage contract:
- Always specify the "provider" argument explicitly on every market data tool call (typically "yfinance"; you may use "stooq" as a fallback).
- For historical data ("equity_price_historical"), always specify appropriate date ranges (start_date and end_date) and an interval (e.g. "1d").
- Expect tool responses to include "structuredContent" with normalized keys plus a "raw" field containing the provider-specific payload.
- When you receive historical OHLCV rows, explicitly compute and cite numerical metrics such as: start_close, end_close, percent change over the window, max and min daily returns, largest gap up/down (open vs previous close), and a simple volatility proxy (standard deviation of daily returns) based strictly on the returned rows.
- Do not invent prices or returns; if data is missing, say so instead of guessing.
- In your final answers, always cite the symbol and provider used, and clearly distinguish between real-time quotes and historical data.
For trading signal questions (e.g., "should I buy", "entry/exit", "position sizing"), you should call "quant_signal" to obtain a model-driven signal. Prefer this tool for short-term action, timing, buy/sell/hold, position suggestions, and stop loss / take profit questions. Do not use it for broad macro or long-term historical analysis.
When "quant_signal" is used successfully, your final answer must explicitly include: signal (BUY/SELL/HOLD), suggested position, confidence, and model name/market context.

=== EVIDENCE-BASED REASONING (CRITICAL) ===
When [RETRIEVED MARKET KNOWLEDGE] is provided:
1. Base your analysis STRICTLY on the retrieved knowledge or tool data. Never invent historical facts, returns, or market characteristics.
2. If information is missing or insufficient, explicitly state: "The retrieved market knowledge does not provide enough information to answer this question completely."
3. Cite specific sources from the retrieved context (e.g., "According to the HK market analysis (chunk 3)...")
4. When retrieved context conflicts with real-time tool data:
   - Prioritize real-time tool data for current prices/quotes
   - Use retrieved context for historical patterns and market characteristics
   - Explicitly note any discrepancies: "Note: Real-time data shows X, while historical analysis indicates Y."

=== COMPARATIVE FINANCIAL REASONING ===
When questions involve market comparisons (e.g., US vs HK, growth vs defensive):
1. Compare using quantitative metrics: return, volatility, drawdown, Sharpe ratio (if available).
2. Mention at least two markets or asset classes being compared.
3. Explain tradeoffs clearly:
   - Growth vs risk: "Market A offers higher returns (X%) but with elevated volatility (Y%), indicating a growth-oriented profile with higher short-term uncertainty."
   - Defensive vs aggressive: "Market B shows lower volatility (X%) but modest returns (Y%), suggesting a defensive allocation suitable for risk-averse investors."
4. Use specific numbers from retrieved knowledge or tool data, not generic statements.

=== RISK INTERPRETATION LAYER ===
Automatically interpret risk metrics when they appear in context:

| Metric | Interpretation |
|--------|---------------|
| High volatility (>20% annualized) | Higher short-term uncertainty; suitable for risk-tolerant investors seeking growth. |
| High drawdown (>30%) | Higher crash risk; indicates potential for significant capital loss during market stress. |
| Low volatility (<10% annualized) | Defensive or stable market; lower return potential but reduced downside risk. |
| High return + high volatility | Growth market with risk; attractive for long-term investors who can tolerate volatility. |
| Low return + low volatility | Defensive allocation; capital preservation focus with limited upside. |

Always contextualize these metrics relative to the specific market and time period.

=== STRUCTURED FINANCIAL OUTPUT FORMAT ===
For market analysis questions, structure your response as follows:

**Market Overview:**
[Summary of market characteristics, recent performance, key metrics from retrieved knowledge or tool data]

**Risk Profile:**
[Volatility interpretation, drawdown analysis, risk factors mentioned in retrieved context]

**Return Characteristics:**
[Historical returns, return distribution, growth patterns from data]

**Comparative Insight (if applicable):**
[Cross-market comparison, relative performance, tradeoffs]

**Conclusion:**
[Synthesized view, key takeaways, data-backed recommendation]

=== PROHIBITED LANGUAGE ===
NEVER use these generic phrases:
- "It depends"
- "Markets can be unpredictable"
- "Various factors affect performance"
- "Results may vary"
- "Past performance doesn't guarantee future results" (unless specifically discussing forward-looking disclaimers)

INSTEAD, use data-backed statements:
- "Based on the retrieved analysis, Market X shows..."
- "Historical data indicates..."
- "The volatility metric of X% suggests..."
- "Comparative analysis reveals..."

=== TOOL vs RAG DISTINCTION ===
When using both MCP tool data and RAG knowledge:
- Clearly separate sources:
  * "According to historical market analysis [source, chunk X]..."
  * "Based on real-time data from [provider]..."
- If both sources address the same metric, compare them explicitly.

=== WRITING STYLE ===
Your tone must resemble:
- Sell-side equity research reports
- Institutional portfolio commentary
- Asset allocation analysis
- Professional investment research

NOT:
- Casual chat or blog style
- Overly simplified explanations
- Generic financial advice
- Personal opinions without data backing

Use professional financial terminology, precise metrics, and evidence-based conclusions.

=== LANGUAGE REQUIREMENTS ===
- Always respond in English only.
- Never use Chinese or any other language unless the user explicitly asks.
- When RAG context contains other languages, extract the financial data and respond in English only.
`;

// ====== RETRIEVAL (BUILD INDEX ONCE) ======
// IMPORTANT:
// - Use OpenAI embedding model name (embeddingRetrievers.ts should call OpenAI /embeddings).
// - Build the knowledge index only once per process run (avoid re-embedding every query).
// - Documents are now chunked with metadata before embedding.
// - Vector store is persisted to disk (.vectorstore.json).

const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const storePath = path.join(currentDir, ".vectorstore.json");
const embeddingRetrievers = new EmbeddingRetrievers(embeddingModel, storePath);

let indexed = false;

/**
 * Build knowledge index with chunking and metadata
 * 
 * Process:
 * 1. Read all markdown files from knowledge/rag_data
 * 2. Chunk each document (700 tokens, 120 overlap)
 * 3. Extract metadata (market, type, source)
 * 4. Embed chunks and store with metadata
 * 5. Save to persistent vector store
 */
async function buildIndexOnce(): Promise<void> {
    if (indexed) {
        logTitle("SKIP INDEXING (Already Indexed)");
        console.log(`Vector store contains ${embeddingRetrievers.size} chunks`);
        return;
    }

    logTitle("BUILDING KNOWLEDGE INDEX");

    // Check if vector store already has data
    if (!embeddingRetrievers.isEmpty) {
        console.log(`Vector store already contains ${embeddingRetrievers.size} chunks`);
        console.log("Skipping re-indexing. Delete .vectorstore.json to force re-index.");
        indexed = true;
        return;
    }

    // Find all markdown files in knowledge/rag_data
    const files = fs.readdirSync(knowledgeDir).filter(file => 
        file.endsWith(".md") && fs.statSync(path.join(knowledgeDir, file)).isFile()
    );

    if (files.length === 0) {
        console.warn(`No markdown files found in ${knowledgeDir}`);
        indexed = true;
        return;
    }

    console.log(`Found ${files.length} markdown files to index`);

    // Index each file
    for (const file of files) {
        const fullPath = path.join(knowledgeDir, file);
        const content = fs.readFileSync(fullPath, "utf-8").trim();
        
        if (!content) {
            console.warn(`Skipping empty file: ${file}`);
            continue;
        }

        console.log(`Indexing: ${file}`);
        await embeddingRetrievers.embedDocument(content, file, {
            chunkSize: 700,
            overlap: 120,
        });
    }

    // Save vector store to disk
    await embeddingRetrievers.save();
    console.log(`\nIndexing complete. Total chunks: ${embeddingRetrievers.size}`);

    indexed = true;
}

// ====== MAIN ======
async function main() {
    // Build knowledge index (only once)
    await buildIndexOnce();

    // prompt 1: Stock Lookup
    const prompt1 =
        "For A-share stock 600519.SH (Kweichow Moutai), retrieve the real-time quote and the last 30 trading days of daily OHLCV data.Summarize the price trend, percentage change, and volatility.Use provider yfinance.";

    const mcpClients = [
        openbbMcpClient,
        fetchMcp,
        fileMcp,
        quantMcp,
        newsSentimentMcp,
        ...(legacyFinnhubMcpClient ? [legacyFinnhubMcpClient] : []),
    ];

    // Create agent with embedding retrievers for dynamic RAG
    // Note: context parameter is now optional (RAG context is retrieved dynamically)
    const agent1 = new Agent(
        "gpt-4.1-mini",
        mcpClients,
        systemPrompt,
        "", // Empty static context - RAG is now dynamic
        embeddingRetrievers
    );

    await agent1.init();
    const result1 = await agent1.invoke(prompt1);

    console.log("\n=== result ===");
    console.log(result1);
}

main().catch(console.error);
