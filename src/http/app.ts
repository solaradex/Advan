import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { paymentMiddleware } from "@x402/express";
import type { Express, NextFunction, Request, Response } from "express";
import type { Network } from "@x402/core/types";
import { AdvanError, PaymentsUnconfiguredError, toAdvanError } from "../errors.js";
import { readUsageEvents, summarizeUsage } from "../stats.js";
import { buildSwapTx } from "../tools/buildSwap.js";
import type { ToolContext } from "../tools/context.js";
import { getQuote } from "../tools/getQuote.js";
import { walletPortfolio } from "../tools/portfolio.js";
import { tokenRisk } from "../tools/tokenRisk.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { createMcpServer } from "../mcp/server.js";
import { httpDiscovery, type X402Runtime } from "../x402/setup.js";

export interface AppOptions {
  ctx: ToolContext;
  x402: X402Runtime | null;
}

export function createApp(options: AppOptions): Express {
  const { ctx, x402 } = options;
  const app = createMcpExpressApp({
    host: ctx.config.host,
    allowedHosts: ctx.config.allowedHosts.length > 0 ? ctx.config.allowedHosts : undefined,
  });
  app.disable("x-powered-by");
  // createMcpExpressApp already installs express.json(). A second parser throws
  // "stream is not readable" because the body has been consumed.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT");
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  if (x402) {
    const network = x402.network as Network;
    const unpaid = (tool: string) => ({
      contentType: "application/json",
      body: {
        error: "payment required",
        code: "payment_required",
        tool,
        price: x402.priceLabel,
        network: x402.network,
        payTo: x402.payTo,
        scheme: "exact",
      },
    });
    app.use(
      paymentMiddleware(
        {
          "POST /v1/token_risk": {
            accepts: {
              scheme: "exact",
              price: x402.priceLabel,
              network,
              payTo: x402.payTo,
            },
            description: `Token risk report (${x402.priceLabel} USDC)`,
            mimeType: "application/json",
            extensions: httpDiscovery("token_risk"),
            unpaidResponseBody: () => unpaid("token_risk"),
          },
          "POST /v1/wallet_portfolio": {
            accepts: {
              scheme: "exact",
              price: x402.priceLabel,
              network,
              payTo: x402.payTo,
            },
            description: `Wallet portfolio (${x402.priceLabel} USDC)`,
            mimeType: "application/json",
            extensions: httpDiscovery("wallet_portfolio"),
            unpaidResponseBody: () => unpaid("wallet_portfolio"),
          },
        },
        x402.resourceServer,
        undefined,
        undefined,
        false,
      ),
    );
  }

  app.get("/", (_req, res) => {
    res.json({
      name: SERVICE_NAME,
      version: VERSION,
      nonCustodial: true,
      routes: {
        health: "GET /health",
        stats: "GET /stats",
        quote: "POST /v1/get_quote",
        swap: "POST /v1/build_swap_tx",
        tokenRisk: "POST /v1/token_risk",
        portfolio: "POST /v1/wallet_portfolio",
        mcp: "POST /mcp",
      },
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: SERVICE_NAME,
      version: VERSION,
      time: new Date().toISOString(),
      checks: {
        referralConfigured: Boolean(ctx.config.referral.account),
        referralFeeBps: ctx.config.referral.feeBps,
        feeCheckMode: ctx.config.feeCheckMode,
        x402Configured: Boolean(x402),
        facilitator: x402?.facilitator.active ?? "none",
        x402Network: ctx.config.x402.network,
        x402PriceUsd: ctx.config.x402.priceUsd,
        swapSelfBroadcastDefault: ctx.config.swapSelfBroadcastDefault,
      },
    });
  });

  app.get("/stats", (_req, res) => {
    if (ctx.config.usageLogPath === "stdout") {
      res.json({
        ...summarizeUsage([]),
        notes: ["USAGE_LOG_PATH is stdout, so this process has no usage file to summarize."],
      });
      return;
    }
    res.json(summarizeUsage(readUsageEvents(ctx.config.usageLogPath)));
  });

  app.post("/v1/get_quote", async (req, res, next) => {
    try {
      res.json(await getQuote(req.body, withPayment(ctx, x402, "free")));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/build_swap_tx", async (req, res, next) => {
    try {
      res.json(await buildSwapTx(req.body, withPayment(ctx, x402, "free")));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/token_risk", async (req, res, next) => {
    try {
      if (!x402) throw new PaymentsUnconfiguredError();
      res.json(await tokenRisk(req.body, withPayment(ctx, x402, "verified")));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/wallet_portfolio", async (req, res, next) => {
    try {
      if (!x402) throw new PaymentsUnconfiguredError();
      res.json(await walletPortfolio(req.body, withPayment(ctx, x402, "verified")));
    } catch (error) {
      next(error);
    }
  });

  app.post("/mcp", (req, res) => handleMcp(req, res, ctx, x402));
  app.get("/mcp", (req, res) => handleMcp(req, res, ctx, x402));
  app.delete("/mcp", (req, res) => handleMcp(req, res, ctx, x402));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const mapped = error instanceof AdvanError ? error : toAdvanError(error);
    if (res.headersSent) return;
    res.status(mapped.status).json({
      error: mapped.message,
      code: mapped.code,
      details: mapped.details,
    });
  });

  return app;
}

function withPayment(ctx: ToolContext, x402: X402Runtime | null, paymentStatus: ToolContext["paymentStatus"]): ToolContext {
  return {
    ...ctx,
    paymentStatus,
    facilitatorName: () => {
      const name = x402?.facilitator.lastFacilitator;
      return name && name !== "none" ? name : undefined;
    },
  };
}

async function handleMcp(req: Request, res: Response, ctx: ToolContext, x402: X402Runtime | null): Promise<void> {
  const server = createMcpServer(ctx, x402);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      const mapped = toAdvanError(error);
      res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
  }
}
