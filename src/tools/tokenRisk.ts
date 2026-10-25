import { UpstreamError } from "../errors.js";
import { scoreTokenRisk, topHoldersPct, type RugcheckSummary } from "../risk/score.js";
import { execute } from "./execute.js";
import { tokenRiskSchema } from "./schemas.js";
import type { ToolContext } from "./context.js";

export async function tokenRisk(input: unknown, ctx: ToolContext) {
  return execute("token_risk", ctx, async () => {
    const { mint } = tokenRiskSchema.parse(input);
    const [rpcResult, jupiterResult, rugcheckResult] = await Promise.allSettled([
      loadRpc(ctx, mint),
      ctx.jupiter.searchToken(mint),
      ctx.rugcheck(mint),
    ]);
    const rpc = rpcResult.status === "fulfilled" ? rpcResult.value : { ok: false as const, error: messageOf(rpcResult.reason) };
    const jupiter = jupiterResult.status === "fulfilled" ? jupiterResult.value : null;
    const rugcheck = rugcheckResult.status === "fulfilled" ? rugcheckResult.value : null;
    if (!rpc.ok && !jupiter && !rugcheck) {
      throw new UpstreamError("token risk sources failed", {
        rpc: rpc.ok ? undefined : rpc.error,
        jupiter: jupiterResult.status === "rejected" ? messageOf(jupiterResult.reason) : "missing",
        rugcheck: rugcheckResult.status === "rejected" ? messageOf(rugcheckResult.reason) : "missing",
      });
    }
    return {
      ...scoreTokenRisk({ mint, rpc, jupiter, rugcheck }),
      disclaimer:
        "Safety score is a heuristic from RPC authorities, Jupiter Tokens V2, and RugCheck. It is not a guarantee against loss.",
    };
  });
}

async function loadRpc(ctx: ToolContext, mint: string) {
  const account = await ctx.rpc.getMint(mint);
  if (!account) return { ok: false as const, error: "mint account not found" };
  let holders = null;
  try {
    const largest = await ctx.rpc.getTokenLargestAccounts(mint);
    holders = topHoldersPct(account.supply, largest);
  } catch {
    holders = null;
  }
  return { ok: true as const, mint: account, topHoldersPct: holders };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

export type { RugcheckSummary };
