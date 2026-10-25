import type { AppConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { referralTokenAccountAddress } from "./jupiter/referralPda.js";
import { createRuntime } from "./runtime.js";
import type { ToolContext } from "./tools/context.js";
import { applicableFacilitatorFees, checkX402Price, priceGuardDecision } from "./x402/priceGuard.js";
import { setupX402, type X402Runtime } from "./x402/setup.js";

export interface BootOptions {
  mirrorStdout: boolean;
}

export async function boot(config: AppConfig, options: BootOptions): Promise<{ ctx: ToolContext; x402: X402Runtime | null }> {
  for (const warning of config.warnings) {
    process.stderr.write(`advan: ${warning}\n`);
  }
  const check = checkX402Price(
    config.x402.priceUsd,
    applicableFacilitatorFees(config.x402),
    config.x402.minFeeMultiple,
  );
  const decision = priceGuardDecision(check, {
    enabled: Boolean(config.x402.payTo),
    mode: config.x402.priceGuard,
  });
  if (decision === "refuse") {
    process.stderr.write(`advan: refusing to start. ${check.warnings.join(" ")}\n`);
    process.exit(1);
  }
  if (decision === "warn") {
    process.stderr.write(`advan: ${check.warnings.join(" ")}\n`);
  }
  const ctx = createRuntime(config, { mirrorStdout: options.mirrorStdout });
  await verifyReferralAccounts(config, ctx);
  const x402 = await setupX402(config, ctx.log);
  if (x402) {
    process.stderr.write(
      `advan: x402 ${config.x402.priceLabel} on ${config.x402.network} via ${x402.facilitator.active} → ${config.x402.payTo}\n`,
    );
  }
  return { ctx, x402 };
}

async function verifyReferralAccounts(config: AppConfig, ctx: ToolContext): Promise<void> {
  const referral = config.referral;
  if (!referral.account) return;
  const mismatches: string[] = [];
  for (const [mint, account] of Object.entries(referral.tokenAccounts)) {
    const expected = await referralTokenAccountAddress(referral.account, mint);
    if (account !== expected) {
      mismatches.push(
        `referral token account for ${mint} is ${account}, expected PDA ${expected} (seeds referral_ata, referral account, mint)`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new ConfigError(mismatches.join("; "));
  }
  for (const [mint, account] of Object.entries(referral.tokenAccounts)) {
    const exists = await ctx.rpc.accountExists(account);
    if (exists === "unknown") {
      process.stderr.write(
        `advan: WARNING: could not check referral token account ${account} for ${mint} on-chain. Fees for that mint may be dropped.\n`,
      );
      continue;
    }
    if (!exists) {
      referral.missingOnChain.push(mint);
      process.stderr.write(
        `advan: WARNING: referral token account ${account} for ${mint} does not exist. Orders whose feeMint is this mint are re-quoted without a referral fee (REFERRAL_MISSING_MINT_MODE=${config.referralMissingMintMode}).\n`,
      );
    }
  }
}
