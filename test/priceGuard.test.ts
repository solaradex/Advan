import { describe, expect, it } from "vitest";
import {
  applicableFacilitatorFees,
  checkX402Price,
  priceGuardDecision,
} from "../src/x402/priceGuard.js";
import { CDP_SETTLEMENT_FEE_USD, PAYAI_MAINNET_EXACT_FEE_USD } from "../src/constants.js";

describe("x402 price versus facilitator fee", () => {
  const mainnetFees = applicableFacilitatorFees({
    payaiFeeUsd: PAYAI_MAINNET_EXACT_FEE_USD,
    cdpFeeUsd: CDP_SETTLEMENT_FEE_USD,
    cdpConfigured: true,
  });

  it("accepts the default $0.01 because it is at least 5x both facilitator fees", () => {
    const check = checkX402Price(0.01, mainnetFees, 5);
    expect(check.ok).toBe(true);
    expect(check.ratios.payai).toBeGreaterThan(7);
    expect(check.ratios.cdp).toBeGreaterThanOrEqual(10);
  });

  it("warns at $0.005 because PayAI mainnet is $0.00133", () => {
    const check = checkX402Price(0.005, mainnetFees, 5);
    expect(check.ok).toBe(false);
    expect(check.warnings.join(" ")).toMatch(/payai/);
  });

  it("treats exactly 5x the CDP fee as acceptable and ignores a zero devnet fee", () => {
    expect(checkX402Price(0.005, [{ name: "cdp", feeUsd: 0.001 }], 5).ok).toBe(true);
    expect(checkX402Price(0.004, [{ name: "cdp", feeUsd: 0.001 }], 5).ok).toBe(false);
    const devnet = checkX402Price(0.005, [{ name: "payai", feeUsd: 0 }], 5);
    expect(devnet.ok).toBe(true);
    expect(devnet.ratios.payai).toBe(Number.POSITIVE_INFINITY);
  });

  it("refuses to boot only when payments are enabled and the guard mode is refuse", () => {
    const low = checkX402Price(0.005, mainnetFees, 5);
    expect(priceGuardDecision(low, { enabled: true, mode: "warn" })).toBe("warn");
    expect(priceGuardDecision(low, { enabled: true, mode: "refuse" })).toBe("refuse");
    expect(priceGuardDecision(low, { enabled: false, mode: "refuse" })).toBe("ok");
    expect(priceGuardDecision(checkX402Price(0.01, mainnetFees, 5), { enabled: true, mode: "refuse" })).toBe("ok");
  });
});
