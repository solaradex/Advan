import { describe, expect, it } from "vitest";
import {
  assertInputAmount,
  assertPriceImpact,
  assertResponseSlippage,
  assertSlippageInput,
  assertTradeUsd,
  priceImpactPercent,
  usdValue,
} from "../src/guards.js";
import { GuardError } from "../src/errors.js";

describe("guards", () => {
  it("rejects a requested slippage above the configured max before a quote exists", () => {
    expect(() => assertSlippageInput(900, 300)).toThrow(GuardError);
    expect(() => assertSlippageInput(300, 300)).not.toThrow();
    expect(() => assertSlippageInput(undefined, 300)).not.toThrow();
  });

  it("rejects a Jupiter-selected slippage above the max", () => {
    expect(() => assertResponseSlippage(undefined, 300)).toThrow(/omitted slippageBps/);
    expect(() => assertResponseSlippage(301, 300)).toThrow(/exceeds maxSlippageBps/);
    expect(assertResponseSlippage(0, 300)).toBeUndefined();
  });

  it("enforces the input amount cap in base units", () => {
    expect(() => assertInputAmount(0n)).toThrow(/greater than 0/);
    expect(() => assertInputAmount(11n, 10n)).toThrow(/maxInputAmount/);
    expect(() => assertInputAmount(10n, 10n)).not.toThrow();
  });

  it("converts base units to USD and enforces the dollar cap", () => {
    expect(usdValue(1_500_000_000n, 9, 100)).toBeCloseTo(150);
    expect(usdValue(5_000_000n, 6, 1)).toBeCloseTo(5);
    expect(() => assertTradeUsd(10.5, 10)).toThrow(/maxTradeUsd/);
    expect(() => assertTradeUsd(10, 10)).not.toThrow();
    expect(() => assertTradeUsd(10_000, undefined)).not.toThrow();
  });

  it("treats priceImpactPct as a fraction and refuses missing or oversized impact", () => {
    expect(priceImpactPercent("-0.000182")).toBeCloseTo(0.0182);
    expect(priceImpactPercent("0.02")).toBeCloseTo(2);
    expect(assertPriceImpact("0.01", 5)).toBeCloseTo(1);
    expect(() => assertPriceImpact("0.06", 5)).toThrow(/price impact/);
    expect(() => assertPriceImpact(undefined, 5)).toThrow(/omitted priceImpactPct/);
  });
});
