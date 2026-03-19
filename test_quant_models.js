#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CASES = [
  { market: "US", ticker: "AAPL" },
  { market: "UK", ticker: "VOD.L" },
  { market: "CN", ticker: "600519.SS" },
  { market: "SG", ticker: "D05.SI" },
  { market: "HK", ticker: "0700.HK" },
];

function summarize(result) {
  if (!result || typeof result !== "object") {
    return { success: false, error: "invalid_result" };
  }
  if (result.error) {
    const diagnostics =
      result.diagnostics && typeof result.diagnostics === "object"
        ? JSON.stringify(result.diagnostics)
        : null;
    return {
      success: false,
      error: diagnostics ? `${result.error} diag=${diagnostics}` : result.error,
    };
  }
  return {
    success: true,
    signal: result.signal,
    position: result.position,
    confidence: result.confidence,
    model_name: result.model_name || result.model,
    market: result.market,
    ticker: result.ticker,
    notes: result.notes || [],
  };
}

async function main() {
  const client = new Client({ name: "quant-smoke-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp-quant-server.js"],
  });

  await client.connect(transport);

  const results = [];
  for (const testCase of CASES) {
    try {
      const res = await client.callTool({
        name: "quant_signal",
        arguments: testCase,
      });
      const structured = res?.structuredContent || res?.content?.[0]?.structuredContent;
      results.push({
        ...testCase,
        summary: summarize(structured),
      });
    } catch (err) {
      results.push({
        ...testCase,
        summary: { success: false, error: String(err) },
      });
    }
  }

  await client.close();

  for (const r of results) {
    const s = r.summary;
    if (!s.success) {
      console.log(`${r.market} ${r.ticker} FAIL: ${s.error}`);
      continue;
    }
    const notes = Array.isArray(s.notes) ? s.notes.join(" | ") : "";
    console.log(
      `${r.market} ${r.ticker} OK: model=${s.model_name} signal=${s.signal} confidence=${s.confidence} notes=${notes}`
    );
  }
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
