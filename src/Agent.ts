import ChatOpenAI from "./ChatOpenAI.js";
import MCPClient from "./MCPClient.js";
import EmbeddingRetrievers from "./embeddingRetrievers.js";
import { RetrievalResult } from "./retrievalPipeline.js";
import { logTitle } from "./util.js";

export default class Agent {
    private mcpClients: MCPClient[];
    private llm: ChatOpenAI | null = null;
    private model: string;
    private systemPrompt: string;
    private context: string;
    private embeddingRetrievers: EmbeddingRetrievers | null;

    constructor(
        model: string,
        mcpClients: MCPClient[],
        systemPrompt: string,
        context: string = "",
        embeddingRetrievers?: EmbeddingRetrievers
    ) {
        this.mcpClients = mcpClients;
        this.model = model;
        this.systemPrompt = systemPrompt;
        this.context = context;
        this.embeddingRetrievers = embeddingRetrievers || null;
    }

    // Initialize LLM and MCP Clients
    public async init() {
        logTitle("INIT LLM AND TOOLS");

        for (const mcpClient of this.mcpClients) {
            await mcpClient.init();
        }

        // Gather all MCP tools
        const allTools = this.mcpClients.flatMap(c => c.getTools());

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

    // Main logic - execute LLM and process tool calls
    // public async invoke(prompt: string) {
    //     if (!this.llm) throw new Error("LLM not initialized");

    //     let response = await this.llm.chat(prompt);

    //     // Add safety loop limit (avoid infinite recursion)
    //     for (let i = 0; i < 10; i++) {
    //         if (response.toolCalls && response.toolCalls.length > 0) {
    //             for (const toolCall of response.toolCalls) {
    //                 const mcp = this.mcpClients.find(mcpClient =>
    //                     mcpClient.getTools().find(t => t.name === toolCall.function.name)
    //                 );

    //                 if (mcp) {
    //                     console.log(`Calling tool: ${toolCall.function.name}`);
    //                     console.log("Arguments:", toolCall.function.arguments);

    //                     let args = {};
    //                     try {
    //                         args = JSON.parse(toolCall.function.arguments || "{}");
    //                     } catch (err) {
    //                         console.warn("Invalid JSON arguments, using empty object:", err);
    //                     }

    //                     const start = Date.now();
    //                     const result = await mcp.callTool(toolCall.function.name, args);
    //                     const elapsed = Date.now() - start;

    //                     console.log(`Result (${elapsed}ms): ${JSON.stringify(result).slice(0, 200)}...`);
    //                     this.llm.appendToolResult(toolCall.id, JSON.stringify(result));
    //                 } else {
    //                     console.warn(`Tool not found: ${toolCall.function.name}`);
    //                     this.llm.appendToolResult(toolCall.id, "Tool not found");
    //                 }
    //             }
    //         } else {
    //             break;
    //         }

    //         response = await this.llm.chat();
    //     }

    //     await this.close();
    //     return response?.content || "";
    // }
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
     */
    private async retrieveRAGContext(query: string): Promise<string> {
        if (!this.embeddingRetrievers || this.embeddingRetrievers.isEmpty) {
            return "";
        }

        try {
            logTitle("RAG RETRIEVAL");
            const results = await this.embeddingRetrievers.retrieve(query, 5);
            
            if (results.length === 0) {
                console.log("No relevant context retrieved.");
                return "";
            }

            console.log(`Retrieved ${results.length} relevant chunks:`);
            results.forEach((r, i) => {
                console.log(`  ${i + 1}. ${r.metadata.source} (chunk ${r.metadata.chunk_id}) - score: ${(r.rerankScore || r.score).toFixed(3)}`);
            });

            return this.buildRAGContext(results);
        } catch (error) {
            console.error("Error retrieving RAG context:", error);
            return "";
        }
    }

    public async invoke(prompt: string) {
        if (!this.llm) throw new Error("LLM not initialized");

        // Dynamically retrieve RAG context for this query
        const ragContext = await this.retrieveRAGContext(prompt);
        
        // Build final prompt with RAG context
        let finalPrompt = prompt;
        if (ragContext) {
            finalPrompt = `${ragContext}\n\n${prompt}`;
        }
        
        // Force English output for this call
        finalPrompt = `${finalPrompt}\n\nPlease respond in English only.`;

        let response = await this.llm.chat(finalPrompt);

        // Add safety loop limit (avoid infinite recursion)
        for (let i = 0; i < 10; i++) {
            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    const mcp = this.mcpClients.find(mcpClient =>
                        mcpClient.getTools().find(t => t.name === toolCall.function.name)
                    );

                    if (mcp) {
                        console.log(`Calling tool: ${toolCall.function.name}`);
                        console.log("Arguments:", toolCall.function.arguments);

                        let args = {};
                        try {
                            args = JSON.parse(toolCall.function.arguments || "{}");
                        } catch (err) {
                            console.warn("Invalid JSON arguments, using empty object:", err);
                        }

                        const start = Date.now();
                        const result = await mcp.callTool(toolCall.function.name, args);
                        const elapsed = Date.now() - start;

                        console.log(`Result (${elapsed}ms): ${JSON.stringify(result).slice(0, 200)}...`);

                        // Only surface the MCP tool output (content/structuredContent), not the wrapper
                        if (result && typeof result === "object" && "success" in result) {
                            const r: any = result as any;
                            if (r.success) {
                                this.llm.appendToolResult(
                                    toolCall.id,
                                    JSON.stringify(r.output ?? {})
                                );
                            } else {
                                this.llm.appendToolResult(
                                    toolCall.id,
                                    JSON.stringify({ error: r.error ?? "Tool call failed" })
                                );
                            }
                        } else {
                            // Fallback: append whatever came back
                            this.llm.appendToolResult(toolCall.id, JSON.stringify(result));
                        }
                    } else {
                        console.warn(`Tool not found: ${toolCall.function.name}`);
                        this.llm.appendToolResult(toolCall.id, "Tool not found");
                    }
                }
            } else {
                break;
            }

            // Follow-up chats will still respect systemPrompt (“English only”)
            response = await this.llm.chat();
        }

        await this.close();
        return response?.content || "";
    }

}
