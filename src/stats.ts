import { readFileSync } from "node:fs";
import { isClientErrorCode } from "./errors.js";
import type { UsageEvent } from "./log.js";

export interface UsageStats {
  totalEvents: number;
  calls: number;
  callsToday: number;
  callsByTool: Record<string, number>;
  errors: number;
  errorsByCode: Record<string, number>;
  /** User/wallet failures such as insufficient_funds. Not included in errors. */
  clientErrors: number;
  clientErrorsByCode: Record<string, number>;
  feeCheckFailures: number;
  x402: {
    verified: number;
    settled: number;
    failedSettlements: number;
    failedVerifications: number;
    usdcAtomicReceived: string;
  };
  referral: {
    eventsWithFee: number;
    estimatedIntegratorFeeRawByMint: Record<string, string>;
  };
  facilitatorFailovers: number;
  facilitatorRecoveries: number;
  referralRequotes: number;
  notes: string[];
}

const NOTES = [
  "calls counts tool invocations, including fee-check failures. x402 settlement rows are not extra calls.",
  "usdcAtomicReceived sums successful x402 settlements recorded in this log (USDC base units, 6 decimals).",
  "estimatedIntegratorFeeRawByMint sums 80% of the quoted fee (Jupiter keeps 20%). On-chain accrued fees are the referral token-account balances, not this estimate.",
  "failedVerifications counts x402 verify failures. referralRequotes counts orders that were priced again without a referral fee because the fee mint had no usable token account.",
  "errors counts server failures. clientErrors counts user/wallet failures such as insufficient_funds and is not included in errors.",
];

function isCall(event: UsageEvent): boolean {
  return event.kind === "tool" || event.kind === "fee_check_failure";
}

export function summarizeUsage(events: UsageEvent[], now = new Date()): UsageStats {
  const today = now.toISOString().slice(0, 10);
  const callsByTool: Record<string, number> = {};
  const errorsByCode: Record<string, number> = {};
  const clientErrorsByCode: Record<string, number> = {};
  const estimated: Record<string, bigint> = {};
  let calls = 0;
  let callsToday = 0;
  let errors = 0;
  let clientErrors = 0;
  let feeCheckFailures = 0;
  let verified = 0;
  let settled = 0;
  let failedSettlements = 0;
  let failedVerifications = 0;
  let usdc = 0n;
  let eventsWithFee = 0;
  let facilitatorFailovers = 0;
  let facilitatorRecoveries = 0;
  let referralRequotes = 0;

  for (const event of events) {
    if (isCall(event)) {
      calls += 1;
      if (event.ts.slice(0, 10) === today) callsToday += 1;
      const tool = event.tool ?? "unknown";
      callsByTool[tool] = (callsByTool[tool] ?? 0) + 1;
      if (!event.success) {
        const code = event.errorCode ?? "error";
        if (isClientErrorCode(code)) {
          clientErrors += 1;
          clientErrorsByCode[code] = (clientErrorsByCode[code] ?? 0) + 1;
        } else {
          errors += 1;
          errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
        }
      }
      if (event.feeBps != null && event.feeBps > 0 && event.estimatedIntegratorFeeRaw && event.feeMint) {
        eventsWithFee += 1;
        estimated[event.feeMint] = (estimated[event.feeMint] ?? 0n) + BigInt(event.estimatedIntegratorFeeRaw);
      }
    }
    if (event.kind === "fee_check_failure") feeCheckFailures += 1;
    if (event.kind === "facilitator_failover") facilitatorFailovers += 1;
    if (event.kind === "facilitator_recovered") facilitatorRecoveries += 1;
    if (event.kind === "referral_requote") referralRequotes += 1;
    if (event.kind === "x402_verification" && !event.success) failedVerifications += 1;
    if (event.paymentStatus === "verified" && isCall(event)) verified += 1;
    if (event.kind === "x402_settlement" && event.success && event.paymentStatus === "settled") {
      settled += 1;
      if (event.usdcAtomic) usdc += BigInt(event.usdcAtomic);
    }
    if (event.kind === "x402_settlement" && event.paymentStatus === "settlement_failed") {
      failedSettlements += 1;
    }
  }

  const estimatedIntegratorFeeRawByMint: Record<string, string> = {};
  for (const [mint, raw] of Object.entries(estimated)) {
    estimatedIntegratorFeeRawByMint[mint] = raw.toString();
  }

  return {
    totalEvents: events.length,
    calls,
    callsToday,
    callsByTool,
    errors,
    errorsByCode,
    clientErrors,
    clientErrorsByCode,
    feeCheckFailures,
    x402: {
      verified,
      settled,
      failedSettlements,
      failedVerifications,
      usdcAtomicReceived: usdc.toString(),
    },
    referral: {
      eventsWithFee,
      estimatedIntegratorFeeRawByMint,
    },
    facilitatorFailovers,
    facilitatorRecoveries,
    referralRequotes,
    notes: NOTES,
  };
}

export function readUsageEvents(filePath: string): UsageEvent[] {
  let text = "";
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
  const events: UsageEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as UsageEvent);
    } catch {
      events.push({
        ts: new Date().toISOString(),
        kind: "tool",
        success: false,
        errorCode: "corrupt_log_line",
        error: "skipped a log line that was not JSON",
      });
    }
  }
  return events;
}
