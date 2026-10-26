import { describe, expect, it } from "vitest";
import { USDC_MAINNET_MINT, USDT_MAINNET_MINT, WSOL_MINT } from "../src/constants.js";
import { ConfigError } from "../src/errors.js";
import { buildReferralTokenAccountMap, selectReferralTokenAccount } from "../src/jupiter/referralAccounts.js";

const SOL_ACCOUNT = "So11111111111111111111111111111111111111112";
const USDC_ACCOUNT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_ACCOUNT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const EXTRA_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const EXTRA_ACCOUNT = "DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc";

describe("referral token account selection", () => {
  it("maps SOL and WSOL onto the wrapped SOL mint and keeps USDC on mainnet", () => {
    const map = buildReferralTokenAccountMap({
      sol: SOL_ACCOUNT,
      usdc: USDC_ACCOUNT,
      usdt: USDT_ACCOUNT,
    });
    expect(selectReferralTokenAccount(WSOL_MINT, map)).toBe(SOL_ACCOUNT);
    expect(selectReferralTokenAccount(USDC_MAINNET_MINT, map)).toBe(USDC_ACCOUNT);
    expect(selectReferralTokenAccount(USDT_MAINNET_MINT, map)).toBe(USDT_ACCOUNT);
    expect(selectReferralTokenAccount("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", map)).toBeUndefined();
  });

  it("accepts the WSOL alias and merges extra mints", () => {
    const map = buildReferralTokenAccountMap({
      wsol: SOL_ACCOUNT,
      extraJson: JSON.stringify({ [EXTRA_MINT]: EXTRA_ACCOUNT }),
    });
    expect(map[WSOL_MINT]).toBe(SOL_ACCOUNT);
    expect(selectReferralTokenAccount(EXTRA_MINT, map)).toBe(EXTRA_ACCOUNT);
  });

  it("rejects conflicting SOL accounts and invalid JSON", () => {
    expect(() => buildReferralTokenAccountMap({ sol: SOL_ACCOUNT, wsol: USDC_ACCOUNT })).toThrow(ConfigError);
    expect(() => buildReferralTokenAccountMap({ extraJson: "[]" })).toThrow(/JSON object/);
    expect(selectReferralTokenAccount(undefined, {})).toBeUndefined();
  });
});
