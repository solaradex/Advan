import { describe, expect, it } from "vitest";
import { WSOL_MINT, USDC_MAINNET_MINT } from "../src/constants.js";
import { bpsOfAmount, evaluateOrderFees, integratorNetBps, isUnconfiguredMintFailure } from "../src/jupiter/fees.js";
import { legacyReferralTokenAccountAddress, referralTokenAccountAddress } from "../src/jupiter/referralPda.js";
import { orderResponse, REFERRAL, REFERRAL_TOKEN_ACCOUNT } from "./helpers.js";

const referral = {
  account: REFERRAL,
  feeBps: 50,
  tokenAccounts: { [WSOL_MINT]: REFERRAL_TOKEN_ACCOUNT },
};

describe("fee assertion", () => {
  it("accepts an exact referral fee with a configured fee mint", async () => {
    const check = await evaluateOrderFees(orderResponse(), referral);
    expect(check.ok).toBe(true);
    expect(check.skipped).toBe(false);
    expect(check.referralTokenAccount).toBe(REFERRAL_TOKEN_ACCOUNT);
    expect(check.estimatedFeeRaw).toBe(bpsOfAmount("100000000", 50));
    expect(check.estimatedIntegratorFeeRaw).toBe("400000");
    expect(integratorNetBps(50)).toBe(40);
  });

  it("allows gasless orders to exceed the configured fee and rejects a shortfall", async () => {
    expect((await evaluateOrderFees(orderResponse({ gasless: true, feeBps: 57 }), referral)).ok).toBe(true);
    const short = await evaluateOrderFees(orderResponse({ gasless: true, feeBps: 49 }), referral);
    expect(short.ok).toBe(false);
    expect(short.failures.join(" ")).toMatch(/gasless feeBps 49/);
  });

  it("fails closed when the fee was dropped to the platform default", async () => {
    const dropped = await evaluateOrderFees(
      orderResponse({ feeBps: 2, referralAccount: null, platformFee: { feeBps: 2, feeMint: WSOL_MINT } }),
      referral,
    );
    expect(dropped.ok).toBe(false);
    expect(dropped.failures.some((failure) => failure.includes("does not equal"))).toBe(true);
    expect(dropped.failures.some((failure) => failure.includes("referralAccount mismatch"))).toBe(true);
  });

  it("fails when the fee mint has no referral token account", async () => {
    const check = await evaluateOrderFees(orderResponse({ feeMint: USDC_MAINNET_MINT, inputMint: USDC_MAINNET_MINT }), referral);
    expect(check.ok).toBe(false);
    expect(check.failures.join(" ")).toMatch(/no referral token account/);
  });

  it("skips the assertion when no referral account is configured", async () => {
    const check = await evaluateOrderFees(orderResponse({ feeBps: 2, referralAccount: null }), {
      feeBps: 50,
      tokenAccounts: {},
    });
    expect(check.ok).toBe(true);
    expect(check.skipped).toBe(true);
  });

  it("rejects a non-gasless fee that is higher than configured", async () => {
    expect((await evaluateOrderFees(orderResponse({ feeBps: 51 }), referral)).ok).toBe(false);
  });

  it("rejects a referral token account that belongs to a different mint", async () => {
    const usdcAta = await referralTokenAccountAddress(REFERRAL, USDC_MAINNET_MINT);
    const swapped = await evaluateOrderFees(orderResponse(), {
      account: REFERRAL,
      feeBps: 50,
      tokenAccounts: { [WSOL_MINT]: usdcAta },
    });
    expect(swapped.ok).toBe(false);
    expect(swapped.failures.join(" ")).toMatch(/does not match the V2 associated token account/);
    expect(isUnconfiguredMintFailure(swapped)).toBe(false);
    expect(usdcAta).not.toBe(REFERRAL_TOKEN_ACCOUNT);
  });

  it("accepts a legacy PDA only after startup has seen it on-chain", async () => {
    const legacy = await legacyReferralTokenAccountAddress(REFERRAL, WSOL_MINT);
    const hidden = await evaluateOrderFees(orderResponse(), {
      account: REFERRAL,
      feeBps: 50,
      tokenAccounts: { [WSOL_MINT]: legacy },
    });
    expect(hidden.ok).toBe(false);
    expect(isUnconfiguredMintFailure(hidden)).toBe(false);
    const accepted = await evaluateOrderFees(orderResponse(), {
      account: REFERRAL,
      feeBps: 50,
      tokenAccounts: { [WSOL_MINT]: legacy },
      legacyMints: [WSOL_MINT],
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.referralTokenAccount).toBe(legacy);
  });
});
