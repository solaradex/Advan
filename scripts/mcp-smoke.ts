/**
 * MCP client smoke test. Checks stdio and Streamable HTTP:
 * four tools are listed, get_quote and build_swap_tx reach Jupiter unless
 * SKIP_LIVE=1, and an unpaid token_risk call is a payment-required (or
 * payments-unconfigured) result. The payment payload is parsed; it is not
 * matched as a substring.
 *
 *   npm run smoke:mcp
 *   SKIP_LIVE=1 npm run smoke:mcp
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { USDC_MAINNET_MINT, WSOL_MINT } from "../src/constants.js";

const PUBLIC_TAKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") env[key] = value;
}
env.USAGE_LOG_STDOUT = "false";
env.USAGE_LOG_PATH = env.USAGE_LOG_PATH || "./logs/mcp-smoke.jsonl";

const root = new URL("..", import.meta.url).pathname;

await exercise("stdio", new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  cwd: root,
  env,
  stderr: "inherit",
}));

const port = await freePort();
const child = spawn(process.execPath, ["--import", "tsx", "src/http-entry.ts"], {
  cwd: root,
  env: { ...env, HOST: "127.0.0.1", PORT: String(port), USAGE_LOG_STDOUT: "false" },
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  await waitForHealth(port);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await exercise("http", transport);
} finally {
  child.kill("SIGTERM");
}

async function exercise(label: string, transport: Transport): Promise<void> {
  const client = new Client({ name: "advan-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const expected = ["build_swap_tx", "get_quote", "token_risk", "wallet_portfolio"];
    if (names.join(",") !== expected.join(",")) {
      throw new Error(`${label}: unexpected tools: ${names.join(", ")}`);
    }
    process.stderr.write(`advan smoke ${label}: tools ok (${names.join(", ")})\n`);

    if (process.env.SKIP_LIVE !== "1") {
      const quote = await client.callTool({
        name: "get_quote",
        arguments: {
          inputMint: WSOL_MINT,
          outputMint: USDC_MAINNET_MINT,
          amount: "10000000",
        },
      });
      const quoteBody = toolJson(quote);
      if (quote.isError) throw new Error(`${label}: get_quote failed: ${JSON.stringify(quoteBody)}`);
      if (typeof quoteBody !== "object" || quoteBody == null || !("outAmount" in quoteBody)) {
        throw new Error(`${label}: get_quote did not include outAmount`);
      }
      process.stderr.write(`advan smoke ${label}: get_quote ok\n`);

      const swap = await client.callTool({
        name: "build_swap_tx",
        arguments: {
          inputMint: WSOL_MINT,
          outputMint: USDC_MAINNET_MINT,
          amount: "10000000",
          taker: PUBLIC_TAKER,
          selfBroadcast: true,
        },
      });
      const swapBody = toolJson(swap);
      if (swap.isError) throw new Error(`${label}: build_swap_tx failed: ${JSON.stringify(swapBody)}`);
      if (!isRecord(swapBody) || swapBody.signing == null || !isRecord(swapBody.signing)) {
        throw new Error(`${label}: build_swap_tx did not include signing`);
      }
      if (swapBody.signing.status !== "unsigned" || typeof swapBody.transaction !== "string") {
        throw new Error(`${label}: build_swap_tx was not an unsigned transaction`);
      }
      process.stderr.write(`advan smoke ${label}: build_swap_tx unsigned ok\n`);
    }

    const risk = await client.callTool({
      name: "token_risk",
      arguments: { mint: USDC_MAINNET_MINT },
    });
    if (!isPaymentBlocked(risk)) {
      throw new Error(`${label}: token_risk returned data without payment: ${JSON.stringify(toolJson(risk)).slice(0, 500)}`);
    }
    process.stderr.write(`advan smoke ${label}: unpaid token_risk blocked\n`);
  } finally {
    await client.close();
  }
}

function isPaymentBlocked(result: { isError?: boolean; structuredContent?: unknown; content?: unknown }): boolean {
  const structured = result.structuredContent;
  if (isPaymentRequired(structured) || isUnconfigured(structured)) return true;
  const body = toolJson(result);
  return isPaymentRequired(body) || isUnconfigured(body);
}

function isPaymentRequired(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.x402Version === "number" && Array.isArray(value.accepts);
}

function isUnconfigured(value: unknown): boolean {
  return isRecord(value) && value.code === "payments_unconfigured";
}

function toolJson(result: { structuredContent?: unknown; content?: unknown }): unknown {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  if (!Array.isArray(result.content)) return result;
  const text = result.content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  if (!isRecord(text) || typeof text.text !== "string") return result;
  try {
    return JSON.parse(text.text) as unknown;
  } catch {
    return text.text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "fetch failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`HTTP server did not become healthy: ${last}`);
}
