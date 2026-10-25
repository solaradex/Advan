import { FeeCheckError, toAdvanError } from "../errors.js";
import { nowIso, type UsageEvent } from "../log.js";
import type { ToolContext } from "./context.js";

interface FeeFields {
  feeCheck?: { ok: boolean; failures: string[] };
  feeBps?: number;
  feeMint?: string;
  estimatedIntegratorFeeRaw?: string;
  referralAccount?: string | null;
}

function feeFields(value: unknown): FeeFields {
  if (!value || typeof value !== "object") return {};
  return value as FeeFields;
}

export async function execute<T>(tool: string, ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const fields = feeFields(result);
    const feeFailed = fields.feeCheck?.ok === false;
    ctx.log.write(event(tool, ctx, started, result, feeFailed));
    return result;
  } catch (error) {
    const mapped = toAdvanError(error);
    const feeFailed = mapped instanceof FeeCheckError;
    ctx.log.write({
      ts: nowIso(),
      kind: feeFailed ? "fee_check_failure" : "tool",
      tool,
      latencyMs: Date.now() - started,
      success: false,
      error: mapped.message,
      errorCode: mapped.code,
      paymentStatus: ctx.paymentStatus,
      facilitator: ctx.facilitatorName?.(),
      failures: feeFailed ? mapped.failures : undefined,
    });
    throw mapped;
  }
}

function event<T>(tool: string, ctx: ToolContext, started: number, result: T, feeFailed: boolean): UsageEvent {
  const fields = feeFields(result);
  return {
    ts: nowIso(),
    kind: feeFailed ? "fee_check_failure" : "tool",
    tool,
    latencyMs: Date.now() - started,
    success: true,
    paymentStatus: ctx.paymentStatus,
    facilitator: ctx.facilitatorName?.(),
    feeBps: fields.feeBps,
    feeMint: fields.feeMint,
    estimatedIntegratorFeeRaw: fields.estimatedIntegratorFeeRaw,
    referralAccount: fields.referralAccount ?? undefined,
    failures: feeFailed ? fields.feeCheck?.failures : undefined,
    errorCode: feeFailed ? "fee_check_failure" : undefined,
  };
}
