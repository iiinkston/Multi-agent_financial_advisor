#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CASES = [
  { market: "US", symbol: "AAPL" },
  { market: "UK", symbol: "VOD.L" },
  { market: "CN", symbol: "600519.SS" },
  { market: "SG", symbol: "D05.SI" },
  { market: "HK", symbol: "0700.HK" },
];

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function main() {
  const client = new Client({ name: "openbb-history-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp-openbb-server.js"],
  });
  await client.connect(transport);

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 200);

  for (const testCase of CASES) {
    try {
      const res = await client.callTool({
        name: "equity_price_historical",
        arguments: {
          symbol: testCase.symbol,
          provider: "yfinance",
          start_date: formatDate(start),
          end_date: formatDate(end),
          interval: "1d",
        },
      });
      const structured = res?.structuredContent || {};
      const rows = Array.isArray(structured.rows) ? structured.rows : [];
      const first = rows[0]?.date || null;
      const last = rows.length ? rows[rows.length - 1]?.date : null;
      const provider = structured.provider || "unknown";
      const error = structured.error || null;
      const rawError =
        structured.raw && typeof structured.raw === "object"
          ? structured.raw.error || structured.raw.details || null
          : null;
      console.log(
        `${testCase.market} ${testCase.symbol} ok rows=${rows.length} provider=${provider} first=${first} last=${last} error=${error} raw=${rawError}`
      );
    } catch (err) {
      console.log(`${testCase.market} ${testCase.symbol} FAIL error=${String(err)}`);
    }
  }

  await client.close();
}

main().catch((err) => {
  console.error("OpenBB history test failed:", err);
  process.exit(1);
});
