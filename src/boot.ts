import type { AppConfig } from "./config.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants.js";
import { ConfigError } from "./errors.js";
import { legacyReferralTokenAccountAddress, resolveConfiguredReferralAccount } from "./jupiter/referralPda.js";
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
    const tokenProgram = await readMintTokenProgram(ctx, mint);
    const legacy = await legacyReferralTokenAccountAddress(referral.account, mint);
    const legacyExists = account === legacy ? await ctx.rpc.accountExists(account) : false;
    const resolved = await resolveConfiguredReferralAccount({
      referralAccount: referral.account,
      mint,
      configured: account,
      tokenProgram,
      legacyExists,
    });
    if (!resolved.ok) {
      mismatches.push(resolved.message);
      continue;
    }
    referral.tokenPrograms[mint] = resolved.tokenProgram;
    if (resolved.kind === "legacy") {
      referral.legacyMints.push(mint);
      process.stderr.write(
        `advan: WARNING: referral token account for ${mint} is the legacy PDA ${account}. It exists, so it is accepted. New accounts from initializeReferralTokenAccountV2 use ${resolved.v2Address}.\n`,
      );
      continue;
    }
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
  if (mismatches.length > 0) throw new ConfigError(mismatches.join("; "));
}

async function readMintTokenProgram(ctx: ToolContext, mint: string): Promise<string | undefined> {
  try {
    const info = await ctx.rpc.getMint(mint);
    if (!info) {
      process.stderr.write(
        `advan: WARNING: mint ${mint} was not found. Its referral account is accepted when it matches either token program's associated token account.\n`,
      );
      return undefined;
    }
    if (info.tokenProgram !== TOKEN_PROGRAM_ID && info.tokenProgram !== TOKEN_2022_PROGRAM_ID) {
      throw new ConfigError(`mint ${mint} is owned by ${info.tokenProgram}, not the Token program or Token-2022`);
    }
    return info.tokenProgram;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    process.stderr.write(
      `advan: WARNING: could not read mint ${mint} to detect its token program. Its referral account is accepted when it matches either token program's associated token account.\n`,
    );
    return undefined;
  }
}
