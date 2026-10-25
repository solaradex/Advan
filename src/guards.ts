import { GuardError } from "./errors.js";

export interface TradeLimits {
  maxSlippageBps: number;
  maxTradeUsd?: number;
  maxInputAmount?: bigint;
  maxPriceImpactPct: number;
}

export function assertSlippageInput(slippageBps: number | undefined, maxSlippageBps: number): void {
  if (slippageBps == null) return;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new GuardError("slippageBps must be an integer from 0 to 10000");
  }
  if (slippageBps > maxSlippageBps) {
    throw new GuardError(`slippageBps ${slippageBps} exceeds maxSlippageBps ${maxSlippageBps}`, {
      slippageBps,
      maxSlippageBps,
    });
  }
}

export function assertInputAmount(amount: bigint, maxInputAmount?: bigint): void {
  if (amount <= 0n) throw new GuardError("amount must be greater than 0");
  if (maxInputAmount != null && amount > maxInputAmount) {
    throw new GuardError(`input amount ${amount.toString()} exceeds maxInputAmount ${maxInputAmount.toString()}`, {
      amount: amount.toString(),
      maxInputAmount: maxInputAmount.toString(),
    });
  }
}

/** USD value of an integer token amount. `usdPrice` is dollars per whole token. */
export function usdValue(amountRaw: bigint, decimals: number, usdPrice: number): number {
  if (decimals < 0 || decimals > 18) throw new GuardError(`unsupported decimals ${decimals}`);
  if (!Number.isFinite(usdPrice) || usdPrice < 0) throw new GuardError("usd price is not a positive finite number");
  const scale = 10n ** BigInt(decimals);
  const whole = amountRaw / scale;
  const frac = amountRaw % scale;
  const tokens = Number(whole) + Number(frac) / Number(scale);
  return tokens * usdPrice;
}

export function assertTradeUsd(usd: number, maxTradeUsd: number | undefined): void {
  if (maxTradeUsd == null) return;
  if (!Number.isFinite(usd)) throw new GuardError("could not price the input amount");
  if (usd > maxTradeUsd + 1e-9) {
    throw new GuardError(`trade size $${usd.toFixed(6)} exceeds maxTradeUsd $${maxTradeUsd}`, {
      usd,
      maxTradeUsd,
    });
  }
}

/**
 * Jupiter `priceImpactPct` is a fraction (a live SOL→USDC quote returned about `-0.00018`).
 * This returns the absolute impact in percent.
 */
export function priceImpactPercent(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.abs(value) * 100;
}

export function assertResponseSlippage(slippageBps: number | undefined, maxSlippageBps: number): void {
  if (slippageBps == null || !Number.isFinite(slippageBps)) {
    throw new GuardError("Jupiter omitted slippageBps; refusing to return the quote");
  }
  if (slippageBps > maxSlippageBps) {
    throw new GuardError(
      `Jupiter selected slippageBps ${slippageBps}, which exceeds maxSlippageBps ${maxSlippageBps}`,
      { slippageBps, maxSlippageBps },
    );
  }
}

export function assertPriceImpact(raw: string | number | null | undefined, maxPriceImpactPct: number): number {
  const pct = priceImpactPercent(raw);
  if (pct == null) {
    throw new GuardError("Jupiter omitted priceImpactPct; refusing to return the quote");
  }
  if (pct > maxPriceImpactPct) {
    throw new GuardError(`price impact ${pct.toFixed(4)}% exceeds maxPriceImpactPct ${maxPriceImpactPct}%`, {
      priceImpactPct: pct,
      maxPriceImpactPct,
    });
  }
  return pct;
}
