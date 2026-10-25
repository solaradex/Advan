import { presentOrder } from "./present.js";
import { execute } from "./execute.js";
import { quoteSchema } from "./schemas.js";
import { applyFeePolicy, guardedOrder } from "./swapShared.js";
import type { ToolContext } from "./context.js";

export async function getQuote(input: unknown, ctx: ToolContext) {
  return execute("get_quote", ctx, async () => {
    const parsed = quoteSchema.parse(input);
    const { order, priceImpactPercent } = await guardedOrder(ctx, { ...parsed, selfBroadcast: false });
    const fee = applyFeePolicy(order, ctx.config);
    return {
      ...presentOrder(order, parsed.inputMint, parsed.outputMint, fee, priceImpactPercent),
      transaction: null,
      note: "Quote only. Call build_swap_tx with the taker address for an unsigned transaction.",
    };
  });
}
