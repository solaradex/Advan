import { FeeCheckError, GuardError, UpstreamError } from "../errors.js";
import { assertSwapSigners, inspectUnsignedTransaction, referralAccountInTransaction } from "../solana/unsignedTx.js";
import { transactionMessageDigest } from "../treasury/executionGuard.js";
import { presentOrder, submitHint } from "./present.js";
import { execute } from "./execute.js";
import { swapSchema } from "./schemas.js";
import { resolvePricedOrder } from "./swapShared.js";
import type { ToolContext } from "./context.js";

export async function buildSwapTx(input: unknown, ctx: ToolContext) {
  return execute("build_swap_tx", ctx, async () => {
    const parsed = swapSchema.parse(input);
    const selfBroadcast = parsed.selfBroadcast ?? ctx.config.swapSelfBroadcastDefault;
    const { order, priceImpactPercent, fee } = await resolvePricedOrder(ctx, { ...parsed, selfBroadcast });
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
    const jupiterz = order.router === "jupiterz" || order.swapType === "rfq";
    const inspected = inspectUnsignedTransaction(order.transaction);
    assertSwapSigners(inspected, {
      taker: parsed.taker,
      jupiterz,
      signatureFeePayer: order.signatureFeePayer,
    });
    let referralAccountInTx: "present" | "absent" | "unverified" | "not_applicable" = "not_applicable";
    if (fee.referralTokenAccount && fee.ok) {
      referralAccountInTx = await referralAccountInTransaction(inspected, fee.referralTokenAccount, ctx.rpc);
      if (referralAccountInTx === "absent") {
        fee.failures.push(
          `referral token account ${fee.referralTokenAccount} is not in the transaction account keys or loaded address lookup tables`,
        );
        fee.ok = false;
        if (ctx.config.feeCheckMode === "fail") throw new FeeCheckError(fee.failures);
      }
    }
    return {
      ...presentOrder(order, parsed.inputMint, parsed.outputMint, fee, priceImpactPercent),
      taker: parsed.taker,
      selfBroadcast,
      transaction: order.transaction,
      treasuryBinding: {
        transactionMessageDigest: transactionMessageDigest(order.transaction),
        message: "SHA-256 digest of the decoded Solana transaction message. Treasury approvals must bind this exact digest; this field does not authorize, sign, or broadcast the transaction.",
      },
      signing: {
        status: "unsigned" as const,
        feePayer: inspected.feePayer,
        signers: inspected.signers,
        message: "This transaction is unsigned. The taker signs it in their own wallet. Advan never signs and never holds keys.",
      },
      referralAccountInTransaction: referralAccountInTx,
      submit: submitHint(selfBroadcast, order, parsed.taker),
      lastValidBlockHeight: order.lastValidBlockHeight,
      expireAt: order.expireAt,
    };
  });
}
