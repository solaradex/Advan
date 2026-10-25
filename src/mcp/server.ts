import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPaymentWrapper } from "@x402/mcp";
import { PaymentsUnconfiguredError, toAdvanError } from "../errors.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { buildSwapTx } from "../tools/buildSwap.js";
import type { ToolContext } from "../tools/context.js";
import { getQuote } from "../tools/getQuote.js";
import { portfolioShape, quoteShape, swapShape, tokenRiskShape } from "../tools/schemas.js";
import { tokenRisk } from "../tools/tokenRisk.js";
import { walletPortfolio } from "../tools/portfolio.js";
import type { X402Runtime } from "../x402/setup.js";

export function createMcpServer(ctx: ToolContext, x402: X402Runtime | null): McpServer {
  const server = new McpServer({
    name: SERVICE_NAME,
    version: VERSION,
  });
  const price = ctx.config.x402.priceLabel;

  server.registerTool(
    "get_quote",
    {
      title: "Get Jupiter quote",
      description:
        "Free Jupiter Swap API V2 quote (GET /swap/v2/order, no taker). Returns amounts, route, slippage, and referral fee fields. Does not return a transaction.",
      inputSchema: quoteShape,
    },
    async (args) => {
      try {
        return ok(await getQuote(args, paidContext(ctx, x402, "free")));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "build_swap_tx",
    {
      title: "Build unsigned swap transaction",
      description:
        "Free. Returns an UNSIGNED base64 transaction for the taker wallet to sign. Advan never signs and never holds keys. Default (selfBroadcast false) keeps JupiterZ routes, which need Jupiter POST /swap/v2/execute to add the market-maker co-signature. Pass selfBroadcast true to exclude jupiterz so the taker can broadcast the signed transaction.",
      inputSchema: swapShape,
    },
    async (args) => {
      try {
        return ok(await buildSwapTx(args, paidContext(ctx, x402, "free")));
      } catch (error) {
        return fail(error);
      }
    },
  );

  const riskDescription = `Paid token risk report (${price} USDC via x402 exact on ${ctx.config.x402.network}). Combines RPC mint/freeze authority, Jupiter Tokens V2, and RugCheck. Ordinary MCP clients that cannot pay receive a payment-required error.`;
  const portfolioDescription = `Paid wallet portfolio (${price} USDC via x402 exact). SOL plus SPL Token and Token-2022 balances, priced with Jupiter Price V3.`;

  if (x402) {
    const paidRisk = createPaymentWrapper(x402.resourceServer, {
      accepts: x402.accepts,
      extensions: x402.discovery.tokenRisk,
      resource: { description: riskDescription, mimeType: "application/json" },
    });
    const paidPortfolio = createPaymentWrapper(x402.resourceServer, {
      accepts: x402.accepts,
      extensions: x402.discovery.portfolio,
      resource: { description: portfolioDescription, mimeType: "application/json" },
    });
    server.registerTool(
      "token_risk",
      { title: "Token risk", description: riskDescription, inputSchema: tokenRiskShape },
      paidRisk(async (args) => {
        try {
          return ok(await tokenRisk(args, paidContext(ctx, x402, "verified")));
        } catch (error) {
          return fail(error);
        }
      }),
    );
    server.registerTool(
      "wallet_portfolio",
      { title: "Wallet portfolio", description: portfolioDescription, inputSchema: portfolioShape },
      paidPortfolio(async (args) => {
        try {
          return ok(await walletPortfolio(args, paidContext(ctx, x402, "verified")));
        } catch (error) {
          return fail(error);
        }
      }),
    );
  } else {
    server.registerTool(
      "token_risk",
      { title: "Token risk", description: riskDescription, inputSchema: tokenRiskShape },
      async () => fail(new PaymentsUnconfiguredError()),
    );
    server.registerTool(
      "wallet_portfolio",
      { title: "Wallet portfolio", description: portfolioDescription, inputSchema: portfolioShape },
      async () => fail(new PaymentsUnconfiguredError()),
    );
  }

  return server;
}

function paidContext(ctx: ToolContext, x402: X402Runtime | null, paymentStatus: ToolContext["paymentStatus"]): ToolContext {
  return {
    ...ctx,
    paymentStatus,
    facilitatorName: () => {
      const name = x402?.facilitator.lastFacilitator;
      return name && name !== "none" ? name : undefined;
    },
  };
}

function ok(data: unknown) {
  const structured = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function fail(error: unknown) {
  const mapped = toAdvanError(error);
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: mapped.message, code: mapped.code, details: mapped.details }),
      },
    ],
  };
}
