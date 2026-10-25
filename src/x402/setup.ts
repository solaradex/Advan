import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { facilitator as payaiFacilitator } from "@payai/facilitator";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import type { AppConfig } from "../config.js";
import { UpstreamError } from "../errors.js";
import { nowIso, type UsageLogger } from "../log.js";
import { FallbackFacilitatorClient } from "./fallbackFacilitator.js";

export interface X402Runtime {
  resourceServer: x402ResourceServer;
  facilitator: FallbackFacilitatorClient;
  accepts: PaymentRequirements[];
  network: string;
  payTo: string;
  priceLabel: string;
  discovery: {
    tokenRisk: Record<string, unknown>;
    portfolio: Record<string, unknown>;
  };
}

export async function setupX402(config: AppConfig, log: UsageLogger): Promise<X402Runtime | null> {
  if (!config.x402.payTo) return null;
  const payTo = config.x402.payTo;
  const fallback = new HTTPFacilitatorClient({
    ...payaiFacilitator,
    timeoutMs: config.x402.facilitatorTimeoutMs,
  });
  const primary = config.x402.cdpConfigured
    ? createCdpFacilitatorClient({
        apiKeyId: process.env.CDP_API_KEY_ID,
        apiKeySecret: process.env.CDP_API_KEY_SECRET,
      })
    : null;
  const facilitator = new FallbackFacilitatorClient(primary, fallback, config.x402.network, (event) => {
    log.write({
      ts: nowIso(),
      kind: "facilitator_failover",
      success: true,
      tool: event.operation,
      error: event.error,
      facilitator: "payai",
      paymentStatus: "not_applicable",
      network: config.x402.network,
    });
  });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(config.x402.network as `${string}:${string}`, new ExactSvmScheme({ rpcUrl: config.solanaRpcUrl }))
    .registerExtension(bazaarResourceServerExtension);
  resourceServer.onAfterSettle(async ({ result, requirements }) => {
    log.write({
      ts: nowIso(),
      kind: "x402_settlement",
      success: result.success,
      paymentStatus: result.success ? "settled" : "settlement_failed",
      usdcAtomic: result.amount ?? requirements.amount,
      facilitator: facilitator.lastFacilitator === "none" ? undefined : facilitator.lastFacilitator,
      network: result.network,
      error: result.errorMessage,
      errorCode: result.success ? undefined : "settlement_failed",
    });
  });
  resourceServer.onSettleFailure(async ({ error }) => {
    log.write({
      ts: nowIso(),
      kind: "x402_settlement",
      success: false,
      paymentStatus: "settlement_failed",
      error: error.message,
      errorCode: "settlement_failed",
      facilitator: facilitator.lastFacilitator === "none" ? undefined : facilitator.lastFacilitator,
      network: config.x402.network,
    });
  });
  try {
    await resourceServer.initialize();
  } catch (error) {
    const message = error instanceof Error ? error.message : "facilitator initialize failed";
    if (config.x402.required) throw new UpstreamError(`x402 facilitator initialize failed: ${message}`);
    process.stderr.write(`x402 facilitator initialize failed: ${message}\n`);
    return null;
  }
  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: config.x402.network as `${string}:${string}`,
    payTo,
    price: config.x402.priceLabel,
  });
  const inputSchema = {
    type: "object",
    properties: { mint: { type: "string", description: "Solana mint address" } },
    required: ["mint"],
  };
  return {
    resourceServer,
    facilitator,
    accepts,
    network: config.x402.network,
    payTo,
    priceLabel: config.x402.priceLabel,
    discovery: {
      tokenRisk: declareDiscoveryExtension({
        toolName: "token_risk",
        description: `Token risk report. Exact scheme ${config.x402.priceLabel} USDC.`,
        inputSchema,
      }),
      portfolio: declareDiscoveryExtension({
        toolName: "wallet_portfolio",
        description: `Wallet portfolio. Exact scheme ${config.x402.priceLabel} USDC.`,
        inputSchema: {
          type: "object",
          properties: { owner: { type: "string", description: "Wallet address" } },
          required: ["owner"],
        },
      }),
    },
  };
}

export function httpDiscovery(tool: "token_risk" | "wallet_portfolio"): Record<string, unknown> {
  const inputSchema =
    tool === "token_risk"
      ? {
          type: "object",
          properties: { mint: { type: "string" } },
          required: ["mint"],
        }
      : {
          type: "object",
          properties: { owner: { type: "string" } },
          required: ["owner"],
        };
  return declareDiscoveryExtension({
    bodyType: "json",
    inputSchema,
    output: { schema: { type: "object" } },
  }) as Record<string, unknown>;
}
