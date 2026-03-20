import ChatOpenAI from "./ChatOpenAI.js";
import MCPClient from "./MCPClient.js";
import EmbeddingRetrievers from "./embeddingRetrievers.js";
import { RetrievalResult } from "./retrievalPipeline.js";
import {
    classifyQuery,
    QueryIntent,
    shouldUseRAG,
    shouldPrioritizeTools,
    shouldDiscourageTools,
} from "./queryClassifier.js";
import { logTitle } from "./util.js";
import {
    buildTradingAnswer,
    initTradingState,
    runTradingWorkflow,
} from "./tradingCoordinator.js";

export default class Agent {
    private mcpClients: MCPClient[];
    private llm: ChatOpenAI | null = null;
    private model: string;
    private systemPrompt: string;
    private context: string;
    private embeddingRetrievers: EmbeddingRetrievers | null;
    private thinkingLog: string[];
    private onThinkingLog?: (message: string) => void;

    constructor(
        model: string,
        mcpClients: MCPClient[],
        systemPrompt: string,
        context: string = "",
        embeddingRetrievers?: EmbeddingRetrievers,
        thinkingLog?: string[],
        onThinkingLog?: (message: string) => void
    ) {
        this.mcpClients = mcpClients;
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.context = context;
        this.embeddingRetrievers = embeddingRetrievers || null;
        this.thinkingLog = thinkingLog || [];
        this.onThinkingLog = onThinkingLog;
    }

    private logThinking(message: string): void {
        console.log(message);
        this.thinkingLog.push(message);
        if (this.onThinkingLog) {
            this.onThinkingLog(message);
        }
    }

    // Initialize LLM and MCP Clients
    public async init() {
        logTitle("INIT LLM AND TOOLS");
        this.logThinking("Initializing LLM and MCP tools");

        for (const mcpClient of this.mcpClients) {
            await mcpClient.init();
            const tools = mcpClient.getTools();
            if (tools.length > 0) {
                const toolNames = tools.map(t => t.name).join(", ");
                this.logThinking(`MCP Client: Connected with tools [${toolNames}]`);
            }
        }

        // Gather all MCP tools
        const allTools = this.mcpClients.flatMap(c => c.getTools());
        this.logThinking(`Loaded ${allTools.length} total MCP tools`);

        // Corrected parameter order
        this.llm = new ChatOpenAI(this.model, this.systemPrompt, allTools, this.context);
    }

    // Close all MCP clients
    public async close() {
        logTitle("CLOSE MCP CLIENTS");
        for (const client of this.mcpClients) {
            await client.close();
        }
    }

    /**
     * Build RAG context block from retrieval results with financial reasoning instructions
     */
    private buildRAGContext(retrievalResults: RetrievalResult[]): string {
        if (retrievalResults.length === 0) {
            return "";
        }

        const contextBlocks = retrievalResults.map((result, index) => {
            const source = result.metadata.source;
            const chunkId = result.metadata.chunk_id;
            const market = result.metadata.market ? ` (${result.metadata.market})` : "";
            const type = result.metadata.type ? ` [${result.metadata.type}]` : "";

            return `[Retrieved Knowledge ${index + 1}]
Source: ${source}${market}${type} (chunk ${chunkId})
Relevance Score: ${(result.rerankScore || result.score).toFixed(3)}

${result.document}`;
        });

        // Extract unique markets and types from retrieved context
        const markets = new Set<string>();
        const types = new Set<string>();
        retrievalResults.forEach(r => {
            if (r.metadata.market) markets.add(r.metadata.market);
            if (r.metadata.type) types.add(r.metadata.type);
        });

        const marketList = Array.from(markets).join(", ");
        const typeList = Array.from(types).join(", ");

        return `[RETRIEVED MARKET KNOWLEDGE]
The following context has been retrieved from your knowledge base. Use this as EVIDENCE for your financial analysis.

Context Summary:
- Markets covered: ${marketList || "Multiple markets"}
- Analysis types: ${typeList || "Mixed analysis"}
- Number of relevant chunks: ${retrievalResults.length}

${contextBlocks.join("\n\n---\n\n")}

[REASONING INSTRUCTIONS]
When answering the user's question:
1. Base your analysis ONLY on the retrieved knowledge above or real-time tool data. Do not invent facts.
2. If the question involves comparison (e.g., US vs HK), use quantitative metrics (return, volatility, drawdown) from the retrieved context.
3. Interpret risk metrics automatically:
   - High volatility → "Higher short-term uncertainty"
   - High drawdown → "Higher crash risk"
   - Low volatility → "Defensive or stable market"
   - High return + high volatility → "Growth market with risk"
4. Structure your response with: Market Overview, Risk Profile, Return Characteristics, Comparative Insight (if applicable), Conclusion.
5. Cite specific sources: "According to [source] (chunk X)..."
6. Avoid generic phrases like "It depends" or "Markets can be unpredictable". Use data-backed statements instead.
7. Clearly distinguish: "According to historical market analysis..." vs "Based on real-time data..."

[USER QUESTION]`;
    }

    /**
     * Retrieve RAG context dynamically based on query
     * Only retrieves if intent indicates RAG should be used
     */
    private async retrieveRAGContext(query: string, intent: QueryIntent): Promise<string> {
        if (!shouldUseRAG(intent)) {
            this.logThinking("RAG: Skipped (REALTIME_DATA intent - using tools only)");
            return "";
        }

        if (!this.embeddingRetrievers || this.embeddingRetrievers.isEmpty) {
            this.logThinking("RAG: Skipped (vector store empty)");
            return "";
        }

        try {
            logTitle("RAG RETRIEVAL");
            const results = await this.embeddingRetrievers.retrieve(query, 5);

            if (results.length === 0) {
                this.logThinking("RAG: No relevant context retrieved");
                return "";
            }

            const sources = results.map(r => `${r.metadata.source} (chunk ${r.metadata.chunk_id})`).join(", ");
            this.logThinking(`RAG: Retrieved ${results.length} chunks from: ${sources}`);
            console.log(`Retrieved ${results.length} relevant chunks:`);
            results.forEach((r, i) => {
                console.log(`  ${i + 1}. ${r.metadata.source} (chunk ${r.metadata.chunk_id}) - score: ${(r.rerankScore || r.score).toFixed(3)}`);
            });

            return this.buildRAGContext(results);
        } catch (error) {
            this.logThinking(`RAG: Error - ${error instanceof Error ? error.message : String(error)}`);
            console.error("Error retrieving RAG context:", error);
            return "";
        }
    }

    /**
     * Build intent-based instruction block for prompt
     */
    private buildIntentInstructions(intent: QueryIntent, query: string): string {
        const discourageTools = shouldDiscourageTools(intent, query);

        switch (intent) {
            case QueryIntent.REALTIME_DATA:
                return `[QUERY INTENT: REALTIME_DATA]
This question focuses on current market data. Prefer MCP tools over historical knowledge.
Use real-time data tools (equity_quote, equity_price_historical) to answer this question.
Historical knowledge may not be relevant for current prices or quotes.`;

            case QueryIntent.HISTORICAL_ANALYSIS:
                return `[QUERY INTENT: HISTORICAL_ANALYSIS]
This question requires historical market analysis. Use retrieved market knowledge as primary evidence.
${discourageTools ? "Avoid using tools unless a specific ticker symbol or date range is mentioned." : "Tools may be used if specific ticker or date data is needed."}`;

            case QueryIntent.RISK_COMPARISON:
                return `[QUERY INTENT: RISK_COMPARISON]
This question requires risk-based comparison. Use retrieved market knowledge as primary evidence.
Focus on volatility, drawdown, and risk metrics from the retrieved context.
${discourageTools ? "Avoid using tools unless a specific ticker symbol is mentioned." : "Tools may be used if specific ticker data is needed for comparison."}`;

            case QueryIntent.MARKET_STRUCTURE:
                return `[QUERY INTENT: MARKET_STRUCTURE]
This question is about market behavior and structural characteristics. Use retrieved market knowledge as primary evidence.
Focus on macro drivers, market dynamics, and structural patterns from the retrieved context.
${discourageTools ? "Avoid using tools unless a specific ticker symbol is mentioned." : "Tools may be used if specific ticker data is needed."}`;

            case QueryIntent.HYBRID_ANALYSIS:
                return `[QUERY INTENT: HYBRID_ANALYSIS]
This question requires combining historical market analysis with current data.
Use retrieved market knowledge for historical context and comparative analysis.
Use MCP tools for real-time data when comparing current conditions.
Both sources should be integrated in your response.`;

            case QueryIntent.UNKNOWN:
            default:
                return `[QUERY INTENT: UNKNOWN]
Use retrieved market knowledge if available, and tools if real-time data is needed.`;
        }
    }

    /**
     * Detect trading intent for quant_signal priority routing
     */
    private isTradingIntent(query: string): boolean {
        const q = query.toLowerCase();
        const tradingKeywords = [
            "buy",
            "sell",
            "hold",
            "enter",
            "exit",
            "position",
            "signal",
            "should i",
            "recommendation",
        ];
        return tradingKeywords.some(k => q.includes(k));
    }

    public async invoke(
        prompt: string,
        onToken?: (token: string) => void
    ): Promise<string> {
        try {
            if (!this.llm) throw new Error("LLM not initialized");

            logTitle("QUERY CLASSIFICATION");
            const classification = classifyQuery(prompt);
            this.logThinking(`Intent Classifier: ${classification.intent} (confidence: ${(classification.confidence * 100).toFixed(0)}%)`);
            if (classification.reasoning) {
                this.logThinking(`Classification Reasoning: ${classification.reasoning}`);
            }
            console.log(`Intent: ${classification.intent} (confidence: ${(classification.confidence * 100).toFixed(1)}%)`);
            if (classification.reasoning) {
                console.log(`Reasoning: ${classification.reasoning}`);
            }

            const tradingIntent = this.isTradingIntent(prompt);
            if (tradingIntent) {
                this.logThinking("Trading workflow: starting multi-agent coordinator");
                const initialState = initTradingState(prompt, classification.intent);
                const finalState = await runTradingWorkflow(initialState, this.mcpClients);
                return buildTradingAnswer(finalState);
            }

            const ragContext = await this.retrieveRAGContext(prompt, classification.intent);
            const intentInstructions = this.buildIntentInstructions(classification.intent, prompt);

            const tradingInstructions = tradingIntent
                ? `[TRADING INTENT OVERRIDE]
This query asks for trading action or signal. Call "quant_signal" first to obtain the model-driven signal.
Do NOT call market data tools (equity_quote, equity_price_historical) before quant_signal.
You may call market data tools only after quant_signal or if quant_signal fails.`
                : "";

            let finalPrompt = prompt;
            if (intentInstructions) {
                finalPrompt = `${intentInstructions}\n\n${finalPrompt}`;
            }
            if (tradingInstructions) {
                finalPrompt = `${tradingInstructions}\n\n${finalPrompt}`;
            }
            if (ragContext) {
                finalPrompt = `${ragContext}\n\n${finalPrompt}`;
            }
            finalPrompt = `${finalPrompt}\n\nPlease respond in English only.`;

            // Use streaming if callback is provided, otherwise use regular chat
            let response;
            if (onToken) {
                response = await this.llm.chatStream(finalPrompt, onToken);
            } else {
                response = await this.llm.chat(finalPrompt);
            }
            this.logThinking("Entered tool-based reasoning loop");

            for (let i = 0; i < 10; i++) {
                if (response.toolCalls && response.toolCalls.length > 0) {
                    for (const toolCall of response.toolCalls) {
                        const mcp = this.mcpClients.find(mcpClient =>
                            mcpClient.getTools().find(t => t.name === toolCall.function.name)
                        );

                        if (mcp) {
                            let args = {};
                            try {
                                args = JSON.parse(toolCall.function.arguments || "{}");
                            } catch (err) {
                                console.warn("Invalid JSON arguments, using empty object:", err);
                            }

                            const argSummary = Object.keys(args).length > 0
                                ? Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 30 ? v.slice(0, 30) + '...' : v}`).join(", ")
                                : "no args";
                            this.logThinking(`Tool Call: ${toolCall.function.name}(${argSummary})`);
                            console.log(`Calling tool: ${toolCall.function.name}`);
                            console.log("Arguments:", toolCall.function.arguments);

                            const start = Date.now();
                            const result = await mcp.callTool(toolCall.function.name, args);
                            const elapsed = Date.now() - start;

                            const success = result && typeof result === "object" && "success" in result
                                ? (result as any).success
                                : true;
                            this.logThinking(`Tool Result: ${toolCall.function.name} completed in ${elapsed}ms (${success ? "success" : "failed"})`);
                            console.log(`Result (${elapsed}ms): ${JSON.stringify(result).slice(0, 200)}...`);

                            if (result && typeof result === "object" && "success" in result) {
                                const r: any = result as any;
                                if (r.success) {
                                    this.llm!.appendToolResult(
                                        toolCall.id,
                                        JSON.stringify(r.output ?? {})
                                    );
                                } else {
                                    this.llm!.appendToolResult(
                                        toolCall.id,
                                        JSON.stringify({ error: r.error ?? "Tool call failed" })
                                    );
                                }
                            } else {
                                this.llm!.appendToolResult(toolCall.id, JSON.stringify(result));
                            }
                        } else {
                            this.logThinking(`Tool Call: ${toolCall.function.name} (not found)`);
                            console.warn(`Tool not found: ${toolCall.function.name}`);
                            this.llm!.appendToolResult(toolCall.id, "Tool not found");
                        }
                    }
                } else {
                    break;
                }

                // After tool calls, continue with streaming if callback is provided
                if (onToken) {
                    response = await this.llm!.chatStream(undefined, onToken);
                } else {
                    response = await this.llm!.chat();
                }
            }

            return response?.content || "";
        } catch (error) {
            this.logThinking(`Error in invoke: ${error instanceof Error ? error.message : String(error)}`);
            console.error("Error in Agent.invoke():", error);
            await this.close().catch(() => { });
            return "";
        }
    }

}
