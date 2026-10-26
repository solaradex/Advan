import { describe, expect, it } from "vitest";
import { httpDiscovery, DISCOVERY_EXAMPLES } from "../src/x402/setup.js";
import { quoteSchema, swapSchema, tokenRiskSchema, portfolioSchema } from "../src/tools/schemas.js";
import { ConfigError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { SOLANA_DEVNET_CAIP, SOLANA_MAINNET_CAIP, USDC_DEVNET_MINT, USDC_MAINNET_MINT, WSOL_MINT, usdcMintForNetwork } from "../src/constants.js";
import { CDP_RECOVERY_INTERVAL_MS } from "../src/x402/fallbackFacilitator.js";

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
    expect(config.host).toBe("127.0.0.1");
    expect(config.limits.maxTradeUsd).toBe(1000);
    expect(config.referralMissingMintMode).toBe("requote");
    expect(config.x402.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(config.solanaRpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(config.x402.rpcUrl).not.toBe(config.solanaRpcUrl);
    expect(usdcMintForNetwork(SOLANA_DEVNET_CAIP)).toBe(USDC_DEVNET_MINT);
    expect(usdcMintForNetwork("devnet")).toBe(USDC_DEVNET_MINT);
    expect(usdcMintForNetwork(SOLANA_MAINNET_CAIP)).toBe(USDC_MAINNET_MINT);
    expect(config.x402.cdpRecoveryIntervalMs).toBe(CDP_RECOVERY_INTERVAL_MS);
    expect(loadConfig({ X402_CDP_RECOVERY_INTERVAL_MS: "1000" }).x402.cdpRecoveryIntervalMs).toBe(1000);
    expect(loadConfig({ X402_NETWORK: "mainnet", X402_RPC_URL: "https://rpc.example" }).x402.rpcUrl).toBe(
      "https://rpc.example",
    );
    const discovery = httpDiscovery("token_risk") as {
      bazaar: { info: { input: { body: { mint: string } } } };
    };
    expect(discovery.bazaar.info.input.body.mint).toBe(DISCOVERY_EXAMPLES.tokenRisk.mint);
    const portfolio = httpDiscovery("wallet_portfolio") as {
      bazaar: { info: { input: { body: { owner: string } } } };
    };
    expect(portfolio.bazaar.info.input.body.owner).toBe(DISCOVERY_EXAMPLES.portfolio.owner);
  });
});
