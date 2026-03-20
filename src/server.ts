import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import MCPClient from "./MCPClient.js";
import Agent from "./Agent.js";
import EmbeddingRetrievers from "./embeddingRetrievers.js";
import { logTitle } from "./util.js";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const currentDir = process.cwd();
const frontendDir = path.join(currentDir, "frontend");
const knowledgeDir = path.join(currentDir, "knowledge", "rag_data");

if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
}

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

=== OUTPUT FORMAT REQUIREMENTS ===
CRITICAL: Your final answer must be written in plain natural language with NO Markdown formatting.

- Write in flowing paragraphs using natural human language
- Do NOT use Markdown syntax: no **bold**, no ## headings, no bullet points (- or •), no code blocks
- Do NOT use section headers, asterisks, dashes, or any formatting symbols
- Structure your analysis through natural paragraph transitions, not visual formatting
- Write as if you are a senior analyst speaking directly to a client in a professional conversation

For market analysis questions, organize your response conceptually (not visually) by covering:
- Market overview: summary of market characteristics, recent performance, key metrics from retrieved knowledge or tool data
- Risk profile: volatility interpretation, drawdown analysis, risk factors mentioned in retrieved context
- Return characteristics: historical returns, return distribution, growth patterns from data
- Comparative insight (if applicable): cross-market comparison, relative performance, tradeoffs
- Conclusion: synthesized view, key takeaways, data-backed recommendation

Present these concepts in natural flowing paragraphs without any formatting markers.

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

=== FINAL ANSWER FORMATTING (CRITICAL) ===
Your final answer to the user must be written in plain text with absolutely no Markdown formatting:
- Use natural paragraphs only
- Do NOT use **bold**, ## headings, - bullets, • symbols, or any Markdown syntax
- Do NOT use section headers or visual separators
- Write as natural human language, like a senior analyst explaining findings in conversation
- Present information through clear paragraph flow, not through formatting symbols
`;

// Manual web test prompts (quant signal):
// - Should I buy AAPL now?
// - Give me a short-term signal for VOD.L
// - Should I enter 0700.HK today?
// - What is the position suggestion for D05.SI?
// - Should I hold or sell 600519.SS?

const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const storePath = path.join(currentDir, ".vectorstore.json");
const embeddingRetrievers = new EmbeddingRetrievers(embeddingModel, storePath);
let indexed = false;

async function buildIndexOnce(): Promise<void> {
    if (indexed) return;

    logTitle("BUILDING KNOWLEDGE INDEX");

    if (!embeddingRetrievers.isEmpty) {
        indexed = true;
        return;
    }

    const files = fs.readdirSync(knowledgeDir).filter(file =>
        file.endsWith(".md") && fs.statSync(path.join(knowledgeDir, file)).isFile()
    );

    if (files.length === 0) {
        indexed = true;
        return;
    }

    for (const file of files) {
        const fullPath = path.join(knowledgeDir, file);
        const content = fs.readFileSync(fullPath, "utf-8").trim();
        if (!content) continue;

        await embeddingRetrievers.embedDocument(content, file, {
            chunkSize: 700,
            overlap: 120,
        });
    }

    await embeddingRetrievers.save();
    indexed = true;
}

async function runAgent(
    query: string,
    onThinkingLog?: (message: string) => void,
    onToken?: (token: string) => void
): Promise<{ answer: string; thinking?: string }> {
    await buildIndexOnce();

    const openbbMcpClient = new MCPClient("openbb-server", "node", ["mcp-openbb-server.js"]);
    const useLegacyFinnhub = process.env.USE_LEGACY_FINNHUB === "true";
    const legacyFinnhubMcpClient = useLegacyFinnhub
        ? new MCPClient("legacy-finnhub", "node", ["mcp-stock-server.js"])
        : null;
    const fetchMcp = new MCPClient("fetch", "uvx", ["mcp-server-fetch"]);
    const fileMcp = new MCPClient("file", "npx", [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        currentDir,
    ]);
    const quantMcp = new MCPClient("quant-model", "node", ["mcp-quant-server.js"]);
    const newsSentimentMcp = new MCPClient("news-sentiment", "node", ["mcp-news-sentiment-server.js"]);

    const mcpClients = [
        openbbMcpClient,
        fetchMcp,
        fileMcp,
        quantMcp,
        newsSentimentMcp,
        ...(legacyFinnhubMcpClient ? [legacyFinnhubMcpClient] : []),
    ];

    const thinkingLog: string[] = [];
    const agent = new Agent(
        process.env.OPENAI_MODEL || "gpt-4.1-mini",
        mcpClients,
        systemPrompt,
        "",
        embeddingRetrievers,
        thinkingLog,
        onThinkingLog
    );

    try {
        await agent.init();
        const answer = await agent.invoke(query, onToken);
        await agent.close();

        const result: { answer: string; thinking?: string } = { answer };
        if (thinkingLog.length > 0) {
            result.thinking = thinkingLog.join("\n");
        }
        return result;
    } catch (error) {
        throw error;
    }
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
    const urlPath = req.url ? req.url.split("?")[0] : "/";
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    let filePath = path.join(frontendDir, safePath);

    if (safePath === "/" || safePath.endsWith("/")) {
        filePath = path.join(frontendDir, "index.html");
    }

    if (!filePath.startsWith(frontendDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType =
            ext === ".html"
                ? "text/html"
                : ext === ".js"
                    ? "text/javascript"
                    : ext === ".css"
                        ? "text/css"
                        : "application/octet-stream";

        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
    });
}

const server = http.createServer(async (req, res) => {
    const { method, url } = req;

    if (url === "/api/agent/run" && method === "POST") {
        const streamMode = req.headers.accept?.includes("text/event-stream");

        if (streamMode) {
            try {
                const body = await readBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const query = typeof parsed?.query === "string" ? parsed.query.trim() : "";

                if (!query) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Missing query" }));
                    return;
                }

                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                });

                const sendSSE = (type: string, data: unknown) => {
                    const payload = JSON.stringify(data);
                    res.write(`event: ${type}\ndata: ${payload}\n\n`);
                };

                let answer = "";
                const thinkingLog: string[] = [];

                const onThinkingLog = (message: string) => {
                    thinkingLog.push(message);
                    sendSSE("thinking", { message });
                };

                const onToken = (token: string) => {
                    answer += token;
                    sendSSE("answer", { answer });
                };

                try {
                    const result = await runAgent(query, onThinkingLog, onToken);
                    // Ensure final answer is sent (in case streaming didn't capture everything)
                    if (result.answer && result.answer !== answer) {
                        answer = result.answer;
                        sendSSE("answer", { answer });
                    }
                    sendSSE("done", {});
                } catch (error) {
                    sendSSE("error", { error: (error as Error).message || "Server error" });
                } finally {
                    res.end();
                }
            } catch (error) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: (error as Error).message || "Server error" }));
            }
            return;
        } else {
            try {
                const body = await readBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const query = typeof parsed?.query === "string" ? parsed.query.trim() : "";

                if (!query) {
                    sendJson(res, 400, { error: "Missing query" });
                    return;
                }

                const result = await runAgent(query);
                sendJson(res, 200, result);
            } catch (error) {
                sendJson(res, 500, { error: (error as Error).message || "Server error" });
            }
            return;
        }
    }

    if (method === "GET" || method === "HEAD") {
        serveStatic(req, res);
        return;
    }

    res.writeHead(405);
    res.end("Method not allowed");
});

const port = Number(process.env.PORT || 5173);
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
