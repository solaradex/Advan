import { JUPITER_REFERRAL_CUT_BPS } from "../constants.js";
import type { ReferralConfig } from "../config.js";
import { selectReferralTokenAccount } from "./referralAccounts.js";
import { referralTokenAccountAddress } from "./referralPda.js";
import type { OrderResponse } from "./types.js";

export interface FeeCheck {
  ok: boolean;
  skipped: boolean;
  failures: string[];
  feeBps?: number;
  feeMint?: string;
  referralTokenAccount?: string;
  estimatedFeeRaw?: string;
  estimatedIntegratorFeeRaw?: string;
  integratorNetBps?: number;
  warning?: string;
  omittedReferral?: boolean;
}

export interface FeeAssertionConfig {
  account?: string;
  feeBps: number;
  tokenAccounts: Record<string, string>;
  /** Mints whose configured token account was confirmed missing when the process started. */
  missingOnChain?: readonly string[];
}

export function integratorNetBps(feeBps: number): number {
  const cut = Math.floor((feeBps * JUPITER_REFERRAL_CUT_BPS) / 10_000);
  return feeBps - cut;
}

export function bpsOfAmount(amountRaw: string, feeBps: number): string {
  return ((BigInt(amountRaw) * BigInt(feeBps)) / 10_000n).toString();
}

export function estimateReferralFee(
  order: Pick<OrderResponse, "inAmount" | "outAmount" | "feeBps" | "feeMint" | "inputMint" | "outputMint">,
  inputMint: string,
  outputMint: string,
): { estimatedFeeRaw?: string; estimatedIntegratorFeeRaw?: string; basis: "input" | "output" | "unknown" } {
  if (order.feeBps == null || order.feeMint == null) return { basis: "unknown" };
  const mint = order.feeMint;
  const side = mint === (order.inputMint ?? inputMint) ? "input" : mint === (order.outputMint ?? outputMint) ? "output" : "unknown";
  if (side === "unknown") return { basis: "unknown" };
  const base = side === "input" ? order.inAmount : order.outAmount;
  const estimatedFeeRaw = bpsOfAmount(base, order.feeBps);
  const estimatedIntegratorFeeRaw = ((BigInt(estimatedFeeRaw) * BigInt(10_000 - JUPITER_REFERRAL_CUT_BPS)) / 10_000n).toString();
  return { estimatedFeeRaw, estimatedIntegratorFeeRaw, basis: side };
}

/**
 * After `/swap/v2/order` with a referral, Jupiter's total `feeBps` equals the
 * configured referral fee unless the order is gasless (gasless recoup can add bps).
 * A missing referral token account for `feeMint` drops the integrator fee silently
 * and the response falls back to Jupiter's platform fee.
 */
export function isUnconfiguredMintFailure(fee: FeeCheck): boolean {
  if (fee.ok || fee.skipped) return false;
  if (fee.failures.some((failure) => failure.includes("does not match referral PDA"))) return false;
  return fee.failures.some(
    (failure) => failure.includes("no referral token account") || failure.includes("missing on-chain"),
  );
}

export async function evaluateOrderFees(order: OrderResponse, referral: FeeAssertionConfig): Promise<FeeCheck> {
  if (!referral.account) {
    return { ok: true, skipped: true, failures: [] };
  }
  const failures: string[] = [];
  if (order.referralAccount !== referral.account) {
    failures.push(
      `referralAccount mismatch: expected ${referral.account}, got ${order.referralAccount ?? "null"}`,
    );
  }
  const feeBps = order.feeBps;
  if (feeBps == null || !Number.isFinite(feeBps)) {
    failures.push("feeBps missing");
  } else if (order.gasless === true) {
    if (feeBps < referral.feeBps) {
      failures.push(`gasless feeBps ${feeBps} is below configured referral fee ${referral.feeBps}`);
    }
  } else if (feeBps !== referral.feeBps) {
    failures.push(
      `feeBps ${feeBps} does not equal configured referral fee ${referral.feeBps} (gasless is false, so extra bps are not expected)`,
    );
  }
  const feeMint = order.feeMint ?? order.platformFee?.feeMint;
  let referralTokenAccount: string | undefined;
  if (!feeMint) {
    failures.push("feeMint missing");
  } else {
    referralTokenAccount = selectReferralTokenAccount(feeMint, referral.tokenAccounts);
    if (!referralTokenAccount) {
      failures.push(
        `no referral token account configured for feeMint ${feeMint}; Jupiter would drop the integrator fee`,
      );
    } else if (referral.account) {
      const expected = await referralTokenAccountAddress(referral.account, feeMint);
      if (referralTokenAccount !== expected) {
        failures.push(
          `referral token account ${referralTokenAccount} for feeMint ${feeMint} does not match referral PDA ${expected} (seeds: referral_ata, referral account, mint). A swapped account drops the integrator fee.`,
        );
      } else if (referral.missingOnChain?.includes(feeMint)) {
        failures.push(
          `referral token account ${referralTokenAccount} for feeMint ${feeMint} was missing on-chain at startup; Jupiter would drop the integrator fee`,
        );
      }
    }
  }
  const estimate = estimateReferralFee(order, order.inputMint ?? "", order.outputMint ?? "");
  return {
    ok: failures.length === 0,
    skipped: false,
    failures,
    feeBps: feeBps ?? undefined,
    feeMint,
    referralTokenAccount,
    estimatedFeeRaw: estimate.estimatedFeeRaw,
    estimatedIntegratorFeeRaw: estimate.estimatedIntegratorFeeRaw,
    integratorNetBps: feeBps == null ? undefined : integratorNetBps(feeBps),
  };
}

export function feeConfigFromReferral(referral: ReferralConfig): FeeAssertionConfig {
  return {
    account: referral.account,
    feeBps: referral.feeBps,
    tokenAccounts: referral.tokenAccounts,
    missingOnChain: referral.missingOnChain,
  };
}
