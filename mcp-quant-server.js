#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { buildQuantFeatures, REQUIRED_FEATURES } from "./quant_feature_builder.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function computeMockSignal(features) {
  const signalStrength =
    toNumber(features?.signal_strength) ||
    toNumber(features?.trend_strength_raw) ||
    toNumber(features?.MA_gap_raw) ||
    toNumber(features?.MA_gap) ||
    0;

  const rawAction = clamp(signalStrength, -1, 1);
  const absAction = Math.abs(rawAction);
  const signal =
    rawAction > 0.1 ? "BUY" : rawAction < -0.1 ? "SELL" : "HOLD";
  const confidence = clamp(absAction, 0.2, 0.95);

  return {
    signal,
    position: rawAction,
    confidence,
    raw_action: rawAction,
    model: "ppo_v1",
  };
}

async function callPythonInference(payload) {
  const pythonExecutable = process.env.PYTHON_EXECUTABLE || "python";
  const args = ["quant_infer.py"];

  return new Promise((resolve) => {
    const child = spawn(pythonExecutable, args, {
      stdio: ["pipe", "pipe", "pipe"],
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
        error: `Failed to start Python process: ${String(err)}`,
        stderr,
      });
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          error: `Python process exited with code ${code}. stderr: ${stderr}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({ ok: true, data: parsed, stderr });
      } catch (e) {
        resolve({
          ok: false,
          error: "Failed to parse JSON from quant_infer.py",
          raw: stdout,
        });
      }
    });
  });
}

const server = new McpServer({
  name: "quant-model",
  version: "0.1.0",
});

server.registerTool(
  "quant_signal",
  {
    title: "Quant model trading signal",
    description:
      "Return a model-driven trading signal given market features.",
    inputSchema: z.object({
      market: z.string().describe("Market identifier, e.g. US, HK"),
      ticker: z.string().describe("Ticker symbol, e.g. AAPL, 700.HK"),
      features: z
        .record(z.any())
        .optional()
        .describe("Feature payload for the quant model (optional)"),
      position: z
        .number()
        .optional()
        .describe("Current position, optional (default: 0)"),
    }),
  },
  async ({ market, ticker, features, position }) => {
    let payload = { market, ticker, features, position };

    if (!features) {
      const built = await buildQuantFeatures({ market, ticker, position });
      if (built.error) {
        return {
          content: [
            {
              type: "text",
              text: `Quant feature build failed for ${ticker} (${market})`,
            },
          ],
          structuredContent: {
            error: built.error,
            market,
            ticker,
            notes: built.notes || [],
            required_features: REQUIRED_FEATURES,
            diagnostics: built.diagnostics || null,
          },
        };
      }

      payload = {
        market: built.market,
        ticker: built.ticker,
        features: built.features,
        position: built.position,
      };
    }

    if (process.env.USE_PYTHON_QUANT !== "false") {
      const result = await callPythonInference(payload);
      if (result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Quant signal for ${ticker} (${market}) via ppo_v1`,
            },
          ],
          structuredContent: result.data,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Quant inference failed for ${ticker} (${market})`,
          },
        ],
        structuredContent: {
          error: result.error,
          market,
          ticker,
          raw: result.raw || null,
          stderr: result.stderr || null,
        },
      };
    }

    const mock = computeMockSignal(payload.features || {});
    return {
      content: [
        {
          type: "text",
          text: `Quant signal for ${ticker} (${market}) via mock ppo_v1: ${mock.signal}`,
        },
      ],
      structuredContent: mock,
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP quant-model server:", err);
  process.exit(1);
});
