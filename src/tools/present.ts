import { JUPITER_EXECUTE_URL } from "../constants.js";
import type { FeeCheck } from "../jupiter/fees.js";
import type { OrderResponse } from "../jupiter/types.js";

export interface PresentedOrder {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  priceImpactPercent?: number;
  router?: string;
  mode?: string;
  swapType?: string;
  requestId?: string;
  routeLabels: string[];
  feeBps?: number;
  feeMint?: string;
  platformFee?: OrderResponse["platformFee"];
  referralAccount?: string | null;
  gasless?: boolean;
  feeCheck: { ok: boolean; skipped: boolean; failures: string[] };
  estimatedFeeRaw?: string;
  estimatedIntegratorFeeRaw?: string;
  integratorNetBps?: number;
  referralTokenAccount?: string;
}

export function presentOrder(
  order: OrderResponse,
  inputMint: string,
  outputMint: string,
  fee: FeeCheck,
  priceImpactPercent?: number,
): PresentedOrder {
  return {
    inputMint,
    outputMint,
    inAmount: order.inAmount,
    outAmount: order.outAmount,
    otherAmountThreshold: order.otherAmountThreshold,
    slippageBps: order.slippageBps,
    priceImpactPct: order.priceImpactPct,
    priceImpactPercent,
    router: order.router,
    mode: order.mode,
    swapType: order.swapType,
    requestId: order.requestId,
    routeLabels: (order.routePlan ?? []).map((hop) => hop.swapInfo?.label ?? "unknown"),
    feeBps: fee.feeBps ?? order.feeBps,
    feeMint: fee.feeMint ?? order.feeMint,
    platformFee: order.platformFee,
    referralAccount: order.referralAccount,
    gasless: order.gasless,
    feeCheck: { ok: fee.ok, skipped: fee.skipped, failures: fee.failures },
    estimatedFeeRaw: fee.estimatedFeeRaw,
    estimatedIntegratorFeeRaw: fee.estimatedIntegratorFeeRaw,
    integratorNetBps: fee.integratorNetBps,
    referralTokenAccount: fee.referralTokenAccount,
  };
}

export function submitHint(selfBroadcast: boolean, order: OrderResponse, taker: string) {
  const coSignRequired = order.router === "jupiterz" || order.swapType === "rfq";
  if (selfBroadcast) {
    return {
      method: "self" as const,
      coSignRequired: false,
      signatureFeePayer: order.signatureFeePayer ?? null,
      note: "JupiterZ was excluded. Sign with the taker wallet and broadcast the transaction yourself. Advan does not sign or broadcast.",
    };
  }
  return {
    method: "jupiter" as const,
    endpoint: JUPITER_EXECUTE_URL,
    requestId: order.requestId,
    body: {
      signedTransaction: "<base64 transaction signed by the taker>",
      requestId: order.requestId,
    },
    coSignRequired,
    taker,
    lastValidBlockHeight: order.lastValidBlockHeight,
    expireAt: order.expireAt,
    note: coSignRequired
      ? "This route needs the market maker co-signature, which Jupiter adds during POST /swap/v2/execute. Do not broadcast the taker-signed transaction yourself."
      : "Default path: the taker signs, then Jupiter lands the transaction via POST /swap/v2/execute. Self-broadcast clients should call build_swap_tx with selfBroadcast true.",
  };
}
