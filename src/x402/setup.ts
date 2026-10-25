import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { facilitator as payaiFacilitator } from "@payai/facilitator";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import type { AppConfig } from "../config.js";
import { USDC_MAINNET_MINT } from "../constants.js";
import { UpstreamError } from "../errors.js";
import { nowIso, type UsageLogger } from "../log.js";
import { FallbackFacilitatorClient } from "./fallbackFacilitator.js";

/** Example inputs required by Bazaar indexing. These are public mints and a placeholder owner. */
export const DISCOVERY_EXAMPLES = {
  tokenRisk: { mint: USDC_MAINNET_MINT },
  portfolio: { owner: "11111111111111111111111111111111" },
} as const;

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
  /** Rebuilds exact-scheme requirements, including a fresh Solana blockhash. */
  buildAccepts(): Promise<PaymentRequirements[]>;
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
  const serverRef: { current?: x402ResourceServer } = {};
  const facilitator = new FallbackFacilitatorClient(
    primary,
    fallback,
    config.x402.network,
    (event) => {
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
    },
    async () => {
      if (!serverRef.current) throw new Error("x402 resource server is not ready");
      await serverRef.current.initialize();
    },
  );
  const resourceServer = new x402ResourceServer(facilitator)
    .register(config.x402.network as `${string}:${string}`, new ExactSvmScheme({ rpcUrl: config.x402.rpcUrl }))
    .registerExtension(bazaarResourceServerExtension);
  serverRef.current = resourceServer;
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
  resourceServer.onAfterVerify(async ({ result, requirements }) => {
    if (result.isValid) return;
    log.write({
      ts: nowIso(),
      kind: "x402_verification",
      success: false,
      paymentStatus: "verification_failed",
      error: result.invalidMessage || result.invalidReason || "payment verification failed",
      errorCode: result.invalidReason ?? "verification_failed",
      facilitator: facilitator.lastFacilitator === "none" ? undefined : facilitator.lastFacilitator,
      network: requirements.network,
      usdcAtomic: requirements.amount,
    });
  });
  resourceServer.onVerifyFailure(async ({ error, requirements }) => {
    log.write({
      ts: nowIso(),
      kind: "x402_verification",
      success: false,
      paymentStatus: "verification_failed",
      error: error.message,
      errorCode: "verification_failed",
      facilitator: facilitator.lastFacilitator === "none" ? undefined : facilitator.lastFacilitator,
      network: requirements.network,
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
  facilitator.startRecoveryProbe();
  const buildAccepts = () =>
    resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: config.x402.network as `${string}:${string}`,
      payTo,
      price: config.x402.priceLabel,
    });
  const accepts = await buildAccepts();
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
    buildAccepts,
    discovery: {
      tokenRisk: declareDiscoveryExtension({
        toolName: "token_risk",
        description: `Token risk report. Exact scheme ${config.x402.priceLabel} USDC.`,
        inputSchema,
        example: { ...DISCOVERY_EXAMPLES.tokenRisk },
        output: { example: { score: 90, level: "low" } },
      }),
      portfolio: declareDiscoveryExtension({
        toolName: "wallet_portfolio",
        description: `Wallet portfolio. Exact scheme ${config.x402.priceLabel} USDC.`,
        inputSchema: {
          type: "object",
          properties: { owner: { type: "string", description: "Wallet address" } },
          required: ["owner"],
        },
        example: { ...DISCOVERY_EXAMPLES.portfolio },
        output: { example: { totalUsd: 0 } },
      }),
    },
  };
}

export function httpDiscovery(tool: "token_risk" | "wallet_portfolio"): Record<string, unknown> {
  if (tool === "token_risk") {
    return declareDiscoveryExtension({
      bodyType: "json",
      input: { ...DISCOVERY_EXAMPLES.tokenRisk },
      inputSchema: {
        type: "object",
        properties: { mint: { type: "string" } },
        required: ["mint"],
      },
      output: { example: { score: 90, level: "low" }, schema: { type: "object" } },
    }) as Record<string, unknown>;
  }
  return declareDiscoveryExtension({
    bodyType: "json",
    input: { ...DISCOVERY_EXAMPLES.portfolio },
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    },
    output: { example: { totalUsd: 0 }, schema: { type: "object" } },
  }) as Record<string, unknown>;
}
