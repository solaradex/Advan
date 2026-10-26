import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { paymentMiddleware } from "@x402/express";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Network } from "@x402/core/types";
import { publicResourceUrl } from "../config.js";
import { redactPaymentRequired } from "./paymentError.js";
import { AdvanError, PaymentsUnconfiguredError, toAdvanError } from "../errors.js";
import { readUsageEvents, summarizeUsage } from "../stats.js";
import { buildSwapTx } from "../tools/buildSwap.js";
import type { ToolContext } from "../tools/context.js";
import { getQuote } from "../tools/getQuote.js";
import { walletPortfolio } from "../tools/portfolio.js";
import { tokenRisk } from "../tools/tokenRisk.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { createMcpServer } from "../mcp/server.js";
import { evaluateTreasuryIntent, type TreasuryIntent, type TreasuryPolicy } from "../treasury/policy.js";
import { bearerAuthorized, TreasuryStore } from "../treasury/store.js";
import { httpDiscovery, type X402Runtime } from "../x402/setup.js";

export interface AppOptions {
  ctx: ToolContext;
  x402: X402Runtime | null;
}

export function createApp(options: AppOptions): Express {
  const { ctx, x402 } = options;
  const treasuryStore = new TreasuryStore(process.env.TREASURY_STORE_PATH?.trim() || "./data/treasury.json");
  const treasuryToken = process.env.TREASURY_API_TOKEN;
  const loopback = isLoopbackHost(ctx.config.host);
  // On a public bind, check hosts ourselves so GET /healthz stays open for Fly's
  // private probe (its Host is the machine address, not advan.fly.dev).
  const customHostCheck = !loopback && ctx.config.allowedHosts.length > 0;
  // createMcpExpressApp warns, and skips protection, when allowedHosts is omitted
  // on 0.0.0.0. Build the app here so /healthz can stay open without that warning.
  const app = customHostCheck ? express() : createMcpExpressApp({
    host: ctx.config.host,
    allowedHosts: ctx.config.allowedHosts.length > 0 ? ctx.config.allowedHosts : undefined,
  });
  if (customHostCheck) {
    app.use(hostAllowList(ctx.config.allowedHosts, ["/healthz"]));
    app.use(express.json());
  }
  if (ctx.config.publicBaseUrl) {
    // One hop: Fly's proxy. req.protocol then follows X-Forwarded-Proto.
    app.set("trust proxy", 1);
  }
  app.disable("x-powered-by");
  // createMcpExpressApp already installs express.json(). A second parser throws
  // "stream is not readable" because the body has been consumed.
  app.use((req, res, next) => {
    const origin = ctx.config.corsOrigin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, PAYMENT-SIGNATURE, X-PAYMENT");
      res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
      if (origin !== "*") res.setHeader("Vary", "Origin");
    }
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode !== 402) return originalJson(body);
      const redacted = redactPaymentRequired(res.getHeader("PAYMENT-REQUIRED"));
      if (redacted.header) res.setHeader("PAYMENT-REQUIRED", redacted.header);
      if (!redacted.reason || redacted.reason === "Payment required") return originalJson(body);
      const base = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      return originalJson({
        ...base,
        error: redacted.reason,
        code: typeof base.code === "string" ? base.code : "payment_required",
      });
    }) as typeof res.json;
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
            resource: publicResourceUrl(ctx.config.publicBaseUrl, "/v1/token_risk"),
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
            resource: publicResourceUrl(ctx.config.publicBaseUrl, "/v1/wallet_portfolio"),
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
        healthz: "GET /healthz",
        stats: "GET /stats",
        quote: "POST /v1/get_quote",
        swap: "POST /v1/build_swap_tx",
        tokenRisk: "POST /v1/token_risk",
        portfolio: "POST /v1/wallet_portfolio",
        mcp: "POST /mcp",
        treasuryEvaluate: "POST /v1/treasury/evaluate (authenticated, evaluation only)",
        treasuryPolicies: "PUT/GET /v1/treasury/policies/:id",
        treasuryApprovals: "GET /v1/treasury/approvals; POST /v1/treasury/approvals/:id/decision",
      },
    });
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/health", (_req, res) => {
    const facilitator = x402?.facilitator.health();
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
        facilitator: facilitator?.active ?? "none",
        cdp: facilitator?.cdp ?? "unconfigured",
        cdpNextProbeAt: facilitator?.cdpNextProbeAt ?? null,
        x402Network: ctx.config.x402.network,
        x402PriceUsd: ctx.config.x402.priceUsd,
        dataRpc: rpcOrigin(ctx.config.solanaRpcUrl),
        x402Rpc: rpcOrigin(ctx.config.x402.rpcUrl),
        dataCluster: ctx.config.dataCluster,
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

  const treasuryAuth = (req: Request, res: Response): boolean => {
    if (!bearerAuthorized(req.header("authorization"), treasuryToken)) {
      res.status(treasuryToken ? 401 : 503).json({ error: treasuryToken ? "Unauthorized" : "Treasury API is not configured", code: treasuryToken ? "unauthorized" : "treasury_unconfigured" });
      return false;
    }
    return true;
  };

  app.put("/v1/treasury/policies/:id", (req, res) => {
    if (!treasuryAuth(req, res)) return;
    try {
      const policy = req.body as TreasuryPolicy;
      if (!policy || typeof policy !== "object" || policy.id !== req.params.id || typeof policy.wallet !== "string") {
        res.status(400).json({ error: "Policy id must match URL and wallet is required", code: "invalid_policy" });
        return;
      }
      // Validate thresholds and fields by evaluating a deliberately safe, zero-value intent.
      evaluateTreasuryIntent(policy, { agentId: "policy-validation", wallet: policy.wallet, inputMint: "validation", outputMint: "validation", amountUsd: 0, slippageBps: 0, priceImpactPct: 0, tokenRiskScore: 0, routeRiskScore: 0, protocolRiskScore: 0, dailyExposureUsd: 0, sessionExposureUsd: 0 });
      treasuryStore.putPolicy(policy);
      treasuryStore.appendAudit({ kind: "policy_upsert", policyId: policy.id, timestamp: new Date().toISOString() });
      res.status(200).json({ saved: true, policyId: policy.id });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid policy", code: "invalid_policy" });
    }
  });

  app.get("/v1/treasury/policies/:id", (req, res) => {
    if (!treasuryAuth(req, res)) return;
    const policy = treasuryStore.getPolicy(req.params.id);
    if (!policy) { res.status(404).json({ error: "Policy not found", code: "policy_not_found" }); return; }
    res.json(policy);
  });

  app.get("/v1/treasury/approvals", (req, res) => {
    if (!treasuryAuth(req, res)) return;
    res.json({ approvals: treasuryStore.listApprovals() });
  });

  app.post("/v1/treasury/approvals/:id/decision", (req, res) => {
    if (!treasuryAuth(req, res)) return;
    const { status, decidedBy, reason } = req.body ?? {};
    if (!["approved", "rejected"].includes(status) || typeof decidedBy !== "string" || !decidedBy.trim()) {
      res.status(400).json({ error: "status and decidedBy are required", code: "invalid_approval" }); return;
    }
    try {
      const approval = treasuryStore.decideApproval(req.params.id, status, decidedBy, typeof reason === "string" ? reason : undefined);
      treasuryStore.appendAudit({ kind: "approval_decision", ...approval });
      res.json(approval);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "Approval conflict", code: "approval_conflict" });
    }
  });

  app.post("/v1/treasury/evaluate", (req, res) => {
    if (!treasuryAuth(req, res)) return;
    try {
      const { policyId, intent } = req.body ?? {};
      if (typeof policyId !== "string" || !intent || typeof intent !== "object") {
        res.status(400).json({ error: "Body must contain policyId and intent", code: "invalid_treasury_request" }); return;
      }
      const policy = treasuryStore.getPolicy(policyId);
      if (!policy) { res.status(404).json({ error: "Policy not found", code: "policy_not_found" }); return; }
      const evaluation = evaluateTreasuryIntent(policy, intent as TreasuryIntent);
      const event = { kind: "treasury_evaluation", intent, policyId, ...evaluation };
      treasuryStore.appendAudit(event);
      if (evaluation.decision === "approval_required") {
        const approval = treasuryStore.createApproval(evaluation.intentId, policyId);
        treasuryStore.appendAudit({ kind: "approval_requested", ...approval });
        res.status(202).json({ ...evaluation, approval });
        return;
      }
      res.json(evaluation);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid treasury request", code: "invalid_treasury_request" });
    }
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

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Host allow-list that leaves liveness probes open. */
export function hostAllowList(allowedHosts: string[], openPaths: readonly string[]): RequestHandler {
  const check = hostHeaderValidation(allowedHosts);
  const open = new Set(openPaths);
  return (req, res, next) => {
    if (open.has(req.path)) {
      next();
      return;
    }
    check(req, res, next);
  };
}

function rpcOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
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
