import type { AppConfig } from "./config.js";
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
  const x402 = await setupX402(config, ctx.log);
  if (x402) {
    process.stderr.write(
      `advan: x402 ${config.x402.priceLabel} on ${config.x402.network} via ${x402.facilitator.active} → ${config.x402.payTo}\n`,
    );
  }
  return { ctx, x402 };
}
