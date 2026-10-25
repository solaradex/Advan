import { describe, expect, it } from "vitest";
import { quoteSchema, swapSchema, tokenRiskSchema, portfolioSchema } from "../src/tools/schemas.js";
import { ConfigError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { WSOL_MINT, USDC_MAINNET_MINT } from "../src/constants.js";

describe("tool input validation", () => {
  it("rejects malformed quote and swap inputs", () => {
    expect(quoteSchema.safeParse({ inputMint: "nope", outputMint: USDC_MAINNET_MINT, amount: "1" }).success).toBe(false);
    expect(quoteSchema.safeParse({ inputMint: WSOL_MINT, outputMint: USDC_MAINNET_MINT, amount: "0" }).success).toBe(false);
    expect(quoteSchema.safeParse({ inputMint: WSOL_MINT, outputMint: USDC_MAINNET_MINT, amount: "-5" }).success).toBe(false);
    expect(quoteSchema.safeParse({ inputMint: WSOL_MINT, outputMint: WSOL_MINT, amount: "1" }).success).toBe(false);
    expect(quoteSchema.safeParse({ inputMint: WSOL_MINT, outputMint: USDC_MAINNET_MINT, amount: "1", extra: true }).success).toBe(false);
    expect(swapSchema.safeParse({ inputMint: WSOL_MINT, outputMint: USDC_MAINNET_MINT, amount: "1" }).success).toBe(false);
    expect(tokenRiskSchema.safeParse({}).success).toBe(false);
    expect(portfolioSchema.safeParse({ owner: "not-a-key" }).success).toBe(false);
    expect(quoteSchema.safeParse({ inputMint: WSOL_MINT, outputMint: USDC_MAINNET_MINT, amount: "1000" }).success).toBe(true);
  });

  it("validates referral fee bounds and ignores keypair material", () => {
    expect(() => loadConfig({ JUPITER_REFERRAL_FEE_BPS: "49" })).toThrow(ConfigError);
    expect(() => loadConfig({ JUPITER_REFERRAL_FEE_BPS: "256" })).toThrow(/50 to 255/);
    expect(loadConfig({ JUPITER_REFERRAL_FEE_BPS: "255" }).referral.feeBps).toBe(255);
    expect(loadConfig({}).referral.feeBps).toBe(50);
    const secret = "/tmp/devnet-payer.json";
    const config = loadConfig({ SOLANA_KEYPAIR_PATH: secret, X402_PAY_TO: "" });
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(config.warnings.join(" ")).toMatch(/SOLANA_KEYPAIR_PATH is ignored/);
    expect(config.swapSelfBroadcastDefault).toBe(false);
    expect(config.x402.priceUsd).toBe(0.01);
    expect(config.x402.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });
});
