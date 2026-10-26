export interface FacilitatorFee {
  name: string;
  feeUsd: number;
}

export interface PriceCheck {
  ok: boolean;
  warnings: string[];
  ratios: Record<string, number>;
}

const MICRO = 1_000_000;

function toMicro(usd: number): bigint {
  return BigInt(Math.round(usd * MICRO));
}

/**
 * Refuse or warn when the advertised price is below `multiple` times the
 * facilitator's per-settlement fee. A zero fee (PayAI devnet) is skipped.
 */
export function checkX402Price(priceUsd: number, fees: FacilitatorFee[], multiple: number): PriceCheck {
  const warnings: string[] = [];
  const ratios: Record<string, number> = {};
  const priceMicro = toMicro(priceUsd);
  const multipleMilli = BigInt(Math.round(multiple * 1000));
  for (const fee of fees) {
    if (!Number.isFinite(fee.feeUsd) || fee.feeUsd <= 0) {
      ratios[fee.name] = Number.POSITIVE_INFINITY;
      continue;
    }
    const feeMicro = toMicro(fee.feeUsd);
    const ratio = Number(priceMicro) / Number(feeMicro);
    ratios[fee.name] = ratio;
    const floor = feeMicro * multipleMilli;
    const scaledPrice = priceMicro * 1000n;
    if (scaledPrice < floor) {
      warnings.push(
        `x402 price $${priceUsd} is ${ratio.toFixed(2)}x the ${fee.name} per-settlement fee $${fee.feeUsd}; the configured minimum is ${multiple}x`,
      );
    }
  }
  return { ok: warnings.length === 0, warnings, ratios };
}

export function priceGuardDecision(
  check: PriceCheck,
  options: { enabled: boolean; mode: "warn" | "refuse" },
): "ok" | "warn" | "refuse" {
  if (!options.enabled || check.ok) return "ok";
  return options.mode === "refuse" ? "refuse" : "warn";
}

export function applicableFacilitatorFees(input: {
  payaiFeeUsd: number;
  cdpFeeUsd: number;
  cdpConfigured: boolean;
}): FacilitatorFee[] {
  const fees: FacilitatorFee[] = [{ name: "payai", feeUsd: input.payaiFeeUsd }];
  if (input.cdpConfigured) fees.push({ name: "cdp", feeUsd: input.cdpFeeUsd });
  return fees;
}
