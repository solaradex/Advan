import type { AppConfig } from "../config.js";
import { FeeCheckError, GuardError } from "../errors.js";
import { assertInputAmount, assertPriceImpact, assertResponseSlippage, assertSlippageInput, assertTradeUsd, usdValue } from "../guards.js";
import { evaluateOrderFees } from "../jupiter/fees.js";
import type { OrderParams, OrderResponse } from "../jupiter/types.js";
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
  if (ctx.config.referral.account) {
    orderParams.referralAccount = ctx.config.referral.account;
    orderParams.referralFee = ctx.config.referral.feeBps;
  }
  if (params.selfBroadcast) orderParams.excludeRouters = "jupiterz";
  const order = await ctx.jupiter.order(orderParams);
  assertResponseSlippage(order.slippageBps, limits.maxSlippageBps);
  const priceImpactPercent = assertPriceImpact(order.priceImpactPct, limits.maxPriceImpactPct);
  return { order, priceImpactPercent };
}

export function applyFeePolicy(order: OrderResponse, config: AppConfig) {
  const fee = evaluateOrderFees(order, config.referral);
  if (!fee.ok && config.feeCheckMode === "fail") throw new FeeCheckError(fee.failures);
  return fee;
}
