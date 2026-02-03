import OpenAI from "openai";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";
import { logTitle } from "./util.js";

// Structure for tool call objects
export interface ToolCall {
    id: string;
    function: {
        name: string;
        arguments: string;
    };
}

export default class ChatOpenAI {
    private llm: OpenAI;
    private model: string;
    private messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    private tools: Tool[];

    constructor(
        model: string,
        systemPrompt: string = "",
        tools: Tool[] = [],
        context: string = ""
    ) {
        this.llm = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: process.env.OPENAI_BASE_URL,
        });

        this.model = model;
        this.tools = tools;

        // Initialize chat messages
        if (systemPrompt) {
            this.messages.push({ role: "system", content: systemPrompt });
        }
        if (context) {
            this.messages.push({ role: "user", content: context });
        }
    }

    // Main chat logic - handles model response and tool calls
    async chat(prompt?: string) {
        logTitle("CHAT");

        if (prompt) {
            this.messages.push({ role: "user", content: prompt });
        }

        const completion = await this.llm.chat.completions.create({
            model: this.model,
            messages: this.messages,
            tools: this.getToolsDefinition(),
            tool_choice: "auto", // safe for OpenAI SDK ≥1.3.7
        });

        logTitle("RESPONSE");

        const choice = completion.choices[0];
        const message = choice.message!;

        const toolCalls: ToolCall[] = [];
        if (message.tool_calls && message.tool_calls.length > 0) {
            for (const call of message.tool_calls) {
                if ('function' in call && call.function) {
                    toolCalls.push({
                        id: call.id || "",
                        function: {
                            name: call.function.name || "",
                            arguments: call.function.arguments || "{}",
                        },
                    });
                }
            }
        }

        // Record model output
        this.messages.push({
            role: "assistant",
            content: message.content || "",
            tool_calls: message.tool_calls ?? [],
        });

        if (message.content) {
            process.stdout.write(`${message.content}\n`);
        }

        return {
            content: message.content || "",
            toolCalls,
        };
    }

    // Streaming chat logic - handles model response with streaming support
    async chatStream(
        prompt: string | undefined,
        onToken: (token: string) => void
    ): Promise<{ content: string; toolCalls: ToolCall[] }> {
        logTitle("CHAT (STREAMING)");

        if (prompt) {
            this.messages.push({ role: "user", content: prompt });
        }

        const stream = await this.llm.chat.completions.create({
            model: this.model,
            messages: this.messages,
            tools: this.getToolsDefinition(),
            tool_choice: "auto",
            stream: true,
        });

        logTitle("RESPONSE (STREAMING)");

        let fullContent = "";
        const toolCalls: ToolCall[] = [];
        let toolCallBuffer: any[] = [];

        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice) continue;

            const delta = choice.delta;

            // Handle content streaming
            if (delta?.content) {
                fullContent += delta.content;
                onToken(delta.content);
                process.stdout.write(delta.content);
            }

            // Handle tool calls streaming
            if (delta?.tool_calls) {
                for (const toolCallDelta of delta.tool_calls) {
                    const index = toolCallDelta.index ?? 0;
                    if (!toolCallBuffer[index]) {
                        toolCallBuffer[index] = {
                            id: toolCallDelta.id || "",
                            function: {
                                name: "",
                                arguments: "",
                            },
                        };
                    }

                    if (toolCallDelta.id) {
                        toolCallBuffer[index].id = toolCallDelta.id;
                    }

                    if (toolCallDelta.function?.name) {
                        toolCallBuffer[index].function.name += toolCallDelta.function.name;
                    }

                    if (toolCallDelta.function?.arguments) {
                        toolCallBuffer[index].function.arguments += toolCallDelta.function.arguments;
                    }
                }
            }
        }

        // Process completed tool calls
        for (const bufferedCall of toolCallBuffer) {
            if (bufferedCall.id && bufferedCall.function.name) {
                toolCalls.push({
                    id: bufferedCall.id,
                    function: {
                        name: bufferedCall.function.name,
                        arguments: bufferedCall.function.arguments || "{}",
                    },
                });
            }
        }

        // Record model output
        this.messages.push({
            role: "assistant",
            content: fullContent,
            tool_calls: toolCalls.length > 0 ? toolCallBuffer.map((tc, idx) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || "{}",
                },
            })) : [],
        });

        if (fullContent) {
            process.stdout.write("\n");
        }

        return {
            content: fullContent,
            toolCalls,
        };
    }

    // Append tool result back to chat context
    public appendToolResult(toolCallId: string, toolOutput: string) {
        this.messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolOutput,
        });
    }

    // Convert MCP tool definitions into OpenAI-compatible format
    private getToolsDefinition() {
        return this.tools.map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description || "No description provided.",
                parameters: tool.inputSchema ?? {
                    type: "object",
                    properties: {},
                },
            },
        }));
    }
}
