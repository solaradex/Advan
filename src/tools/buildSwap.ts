import { GuardError, UpstreamError } from "../errors.js";
import { presentOrder, submitHint } from "./present.js";
import { execute } from "./execute.js";
import { swapSchema } from "./schemas.js";
import { applyFeePolicy, guardedOrder } from "./swapShared.js";
import type { ToolContext } from "./context.js";

export async function buildSwapTx(input: unknown, ctx: ToolContext) {
  return execute("build_swap_tx", ctx, async () => {
    const parsed = swapSchema.parse(input);
    const selfBroadcast = parsed.selfBroadcast ?? ctx.config.swapSelfBroadcastDefault;
    const { order, priceImpactPercent } = await guardedOrder(ctx, { ...parsed, selfBroadcast });
    if (selfBroadcast && order.router === "jupiterz") {
      throw new UpstreamError("Jupiter returned a jupiterz route after excludeRouters=jupiterz; refusing a transaction the taker cannot broadcast");
    }
    if (selfBroadcast && order.signatureFeePayer && order.signatureFeePayer !== parsed.taker) {
      throw new GuardError(
        `signatureFeePayer ${order.signatureFeePayer} is not the taker, so the taker cannot broadcast this transaction`,
      );
    }
    if (!order.transaction) {
      throw new UpstreamError("Jupiter did not return an unsigned transaction. Pass a taker and retry before the quote expires.");
    }
    const fee = applyFeePolicy(order, ctx.config);
    return {
      ...presentOrder(order, parsed.inputMint, parsed.outputMint, fee, priceImpactPercent),
      taker: parsed.taker,
      selfBroadcast,
      transaction: order.transaction,
      signing: {
        status: "unsigned" as const,
        message: "This transaction is unsigned. The taker signs it in their own wallet. Advan never signs and never holds keys.",
      },
      submit: submitHint(selfBroadcast, order, parsed.taker),
      lastValidBlockHeight: order.lastValidBlockHeight,
      expireAt: order.expireAt,
    };
  });
}
