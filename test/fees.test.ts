import { describe, expect, it } from "vitest";
import { WSOL_MINT, USDC_MAINNET_MINT } from "../src/constants.js";
import { bpsOfAmount, evaluateOrderFees, integratorNetBps } from "../src/jupiter/fees.js";
import { orderResponse, REFERRAL, REFERRAL_TOKEN_ACCOUNT } from "./helpers.js";

const referral = {
  account: REFERRAL,
  feeBps: 50,
  tokenAccounts: { [WSOL_MINT]: REFERRAL_TOKEN_ACCOUNT },
};

describe("fee assertion", () => {
  it("accepts an exact referral fee with a configured fee mint", () => {
    const check = evaluateOrderFees(orderResponse(), referral);
    expect(check.ok).toBe(true);
    expect(check.skipped).toBe(false);
    expect(check.referralTokenAccount).toBe(REFERRAL_TOKEN_ACCOUNT);
    expect(check.estimatedFeeRaw).toBe(bpsOfAmount("100000000", 50));
    expect(check.estimatedIntegratorFeeRaw).toBe("400000");
    expect(integratorNetBps(50)).toBe(40);
  });

  it("allows gasless orders to exceed the configured fee and rejects a shortfall", () => {
    expect(evaluateOrderFees(orderResponse({ gasless: true, feeBps: 57 }), referral).ok).toBe(true);
    const short = evaluateOrderFees(orderResponse({ gasless: true, feeBps: 49 }), referral);
    expect(short.ok).toBe(false);
    expect(short.failures.join(" ")).toMatch(/gasless feeBps 49/);
  });

  it("fails closed when the fee was dropped to the platform default", () => {
    const dropped = evaluateOrderFees(
      orderResponse({ feeBps: 2, referralAccount: null, platformFee: { feeBps: 2, feeMint: WSOL_MINT } }),
      referral,
    );
    expect(dropped.ok).toBe(false);
    expect(dropped.failures.some((failure) => failure.includes("does not equal"))).toBe(true);
    expect(dropped.failures.some((failure) => failure.includes("referralAccount mismatch"))).toBe(true);
  });

  it("fails when the fee mint has no referral token account", () => {
    const check = evaluateOrderFees(orderResponse({ feeMint: USDC_MAINNET_MINT, inputMint: USDC_MAINNET_MINT }), referral);
    expect(check.ok).toBe(false);
    expect(check.failures.join(" ")).toMatch(/no referral token account/);
  });

  it("skips the assertion when no referral account is configured", () => {
    const check = evaluateOrderFees(orderResponse({ feeBps: 2, referralAccount: null }), {
      feeBps: 50,
      tokenAccounts: {},
    });
    expect(check.ok).toBe(true);
    expect(check.skipped).toBe(true);
  });

  it("rejects a non-gasless fee that is higher than configured", () => {
    expect(evaluateOrderFees(orderResponse({ feeBps: 51 }), referral).ok).toBe(false);
  });
});
