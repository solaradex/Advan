/**
 * MCP client smoke test. Spawns the stdio server and checks that four tools
 * are listed, get_quote reaches Jupiter, and token_risk does not return data
 * without an x402 payment.
 *
 *   npm run smoke:mcp
 *   SKIP_LIVE=1 npm run smoke:mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { USDC_MAINNET_MINT, WSOL_MINT } from "../src/constants.js";

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") env[key] = value;
}
env.USAGE_LOG_STDOUT = "false";
env.USAGE_LOG_PATH = env.USAGE_LOG_PATH || "./logs/mcp-smoke.jsonl";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  cwd: new URL("..", import.meta.url).pathname,
  env,
  stderr: "inherit",
});
const client = new Client({ name: "advan-smoke", version: "0.0.0" });
await client.connect(transport);

try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = ["build_swap_tx", "get_quote", "token_risk", "wallet_portfolio"];
  if (names.join(",") !== expected.join(",")) {
    throw new Error(`unexpected tools: ${names.join(", ")}`);
  }
  process.stderr.write(`advan smoke: tools ok (${names.join(", ")})\n`);

  if (process.env.SKIP_LIVE !== "1") {
    const quote = await client.callTool({
      name: "get_quote",
      arguments: {
        inputMint: WSOL_MINT,
        outputMint: USDC_MAINNET_MINT,
        amount: "10000000",
      },
    });
    const text = JSON.stringify(quote);
    if (quote.isError) throw new Error(`get_quote failed: ${text}`);
    if (!text.includes("outAmount")) throw new Error("get_quote did not include outAmount");
    process.stderr.write("advan smoke: get_quote ok\n");
  }

  const risk = await client.callTool({
    name: "token_risk",
    arguments: { mint: USDC_MAINNET_MINT },
  });
  const riskText = JSON.stringify(risk);
  const blocked = risk.isError === true || riskText.includes("payment") || riskText.includes("x402") || riskText.includes("payments_unconfigured");
  if (!blocked) throw new Error(`token_risk returned data without payment: ${riskText.slice(0, 500)}`);
  process.stderr.write("advan smoke: unpaid token_risk blocked\n");
} finally {
  await client.close();
}
