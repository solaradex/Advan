import { describe, expect, it } from "vitest";
import { summarizeUsage } from "../src/stats.js";
import type { UsageEvent } from "../src/log.js";
import { WSOL_MINT } from "../src/constants.js";

describe("usage stats", () => {
  it("counts calls, fee-check failures, settlements, and estimated referral fees", () => {
    const events: UsageEvent[] = [
      {
        ts: "2026-10-25T12:00:00.000Z",
        kind: "tool",
        tool: "get_quote",
        success: true,
        paymentStatus: "free",
        feeBps: 50,
        feeMint: WSOL_MINT,
        estimatedIntegratorFeeRaw: "400000",
      },
      {
        ts: "2026-10-25T12:01:00.000Z",
        kind: "fee_check_failure",
        tool: "build_swap_tx",
        success: false,
        errorCode: "fee_check_failure",
        paymentStatus: "free",
      },
      {
        ts: "2026-10-25T12:02:00.000Z",
        kind: "tool",
        tool: "token_risk",
        success: true,
        paymentStatus: "verified",
      },
      {
        ts: "2026-10-25T12:02:01.000Z",
        kind: "x402_settlement",
        success: true,
        paymentStatus: "settled",
        usdcAtomic: "10000",
      },
      {
        ts: "2026-10-24T12:00:00.000Z",
        kind: "x402_settlement",
        success: false,
        paymentStatus: "settlement_failed",
      },
      {
        ts: "2026-10-25T12:03:00.000Z",
        kind: "facilitator_failover",
        success: true,
      },
    ];
    const stats = summarizeUsage(events, new Date("2026-10-25T18:00:00.000Z"));
    expect(stats.calls).toBe(3);
    expect(stats.callsToday).toBe(3);
    expect(stats.callsByTool.get_quote).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.feeCheckFailures).toBe(1);
    expect(stats.x402.settled).toBe(1);
    expect(stats.x402.failedSettlements).toBe(1);
    expect(stats.x402.usdcAtomicReceived).toBe("10000");
    expect(stats.x402.verified).toBe(1);
    expect(stats.referral.estimatedIntegratorFeeRawByMint[WSOL_MINT]).toBe("400000");
    expect(stats.facilitatorFailovers).toBe(1);
  });
});
