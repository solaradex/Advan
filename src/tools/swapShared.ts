import type { AppConfig } from "../config.js";
import { FeeCheckError, GuardError } from "../errors.js";
import { assertInputAmount, assertPriceImpact, assertResponseSlippage, assertSlippageInput, assertTradeUsd, usdValue } from "../guards.js";
import { evaluateOrderFees, isUnconfiguredMintFailure, type FeeCheck } from "../jupiter/fees.js";
import type { OrderParams, OrderResponse } from "../jupiter/types.js";
import { nowIso } from "../log.js";
import type { ToolContext } from "./context.js";

export async function guardedOrder(
  ctx: ToolContext,
  params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
    taker?: string;
    receiver?: string;
    selfBroadcast: boolean;
    skipReferral?: boolean;
  },
): Promise<{ order: OrderResponse; priceImpactPercent: number }> {
  const limits = ctx.config.limits;
  assertSlippageInput(params.slippageBps, limits.maxSlippageBps);
  const amount = BigInt(params.amount);
  assertInputAmount(amount, limits.maxInputAmount);
  if (limits.maxTradeUsd != null) {
    const priced = await ctx.jupiter.prices([params.inputMint]);
    const price = priced[params.inputMint];
    if (!price || price.decimals == null) {
      throw new GuardError("input mint price is unavailable and MAX_TRADE_USD is set, so the quote was refused");
    }
    assertTradeUsd(usdValue(amount, price.decimals, price.usdPrice), limits.maxTradeUsd);
  }
  const orderParams: OrderParams = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    taker: params.taker,
    slippageBps: params.slippageBps,
    receiver: params.receiver,
  };
  if (ctx.config.referral.account && !params.skipReferral) {
    orderParams.referralAccount = ctx.config.referral.account;
    orderParams.referralFee = ctx.config.referral.feeBps;
  }
  if (params.selfBroadcast) orderParams.excludeRouters = "jupiterz";
  const order = await ctx.jupiter.order(orderParams);
  assertResponseSlippage(order.slippageBps, limits.maxSlippageBps);
  const priceImpactPercent = assertPriceImpact(order.priceImpactPct, limits.maxPriceImpactPct);
  return { order, priceImpactPercent };
}

export async function applyFeePolicy(order: OrderResponse, config: AppConfig): Promise<FeeCheck> {
  const fee = await evaluateOrderFees(order, config.referral);
  if (!fee.ok && config.feeCheckMode === "fail" && !suppressUnconfiguredMint(fee, config)) {
    throw new FeeCheckError(fee.failures);
  }
  return fee;
}

/**
 * Quotes with the referral attached. When the only problem is a fee mint that
 * has no usable referral token account, the default is to quote again without
 * the referral and log a warning instead of refusing the swap.
 */
export async function resolvePricedOrder(
  ctx: ToolContext,
  params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
    taker?: string;
    receiver?: string;
    selfBroadcast: boolean;
  },
): Promise<{ order: OrderResponse; priceImpactPercent: number; fee: FeeCheck }> {
  const first = await guardedOrder(ctx, params);
  const fee = await evaluateOrderFees(first.order, ctx.config.referral);
  if (ctx.config.referralMissingMintMode === "requote" && isUnconfiguredMintFailure(fee)) {
    const mint = fee.feeMint ?? "unknown";
    ctx.log.write({
      ts: nowIso(),
      kind: "referral_requote",
      tool: params.taker ? "build_swap_tx" : "get_quote",
      success: true,
      paymentStatus: ctx.paymentStatus,
      errorCode: "referral_mint_unconfigured",
      error: `feeMint ${mint} has no usable referral token account; re-quoting without referralFee`,
      feeMint: fee.feeMint,
      referralAccount: ctx.config.referral.account,
      failures: fee.failures,
    });
    const second = await guardedOrder(ctx, { ...params, skipReferral: true });
    const skipped = await evaluateOrderFees(second.order, { ...ctx.config.referral, account: undefined });
    return {
      order: second.order,
      priceImpactPercent: second.priceImpactPercent,
      fee: {
        ...skipped,
        warning: `Re-quoted without referralFee because feeMint ${mint} has no usable referral token account. Add that mint with npm run setup:referral (REFERRAL_MINTS) or the integrator fee is not charged on this pair.`,
        omittedReferral: true,
      },
    };
  }
  if (!fee.ok && ctx.config.feeCheckMode === "fail" && !suppressUnconfiguredMint(fee, ctx.config)) {
    throw new FeeCheckError(fee.failures);
  }
  return { order: first.order, priceImpactPercent: first.priceImpactPercent, fee };
}

function suppressUnconfiguredMint(fee: FeeCheck, config: AppConfig): boolean {
  return config.referralMissingMintMode === "warn" && isUnconfiguredMintFailure(fee);
}
