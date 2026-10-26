import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreasuryLedger } from "../src/treasury/ledger.js";
import type { BoundExecutionIntent } from "../src/treasury/executionGuard.js";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

const makeIntent = (id = "intent-1"): BoundExecutionIntent => ({
  intentId: id, policyId: "policy-1", wallet: "wallet-1", inputMint: "mint-in", outputMint: "mint-out",
  amount: "1000000", quoteResponse: { outAmount: "42" }, transactionMessageDigest: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
async function setup() {
  directory = await mkdtemp(join(tmpdir(), "advan-ledger-"));
  return new TreasuryLedger(join(directory, "ledger.json"));
}
const limits = { wallet: "wallet-1", dailyLimitUsd: 100, sessionLimitUsd: 70 };

describe("TreasuryLedger", () => {
  it("serializes concurrent reservations and refuses exposure overages", async () => {
    const ledger = await setup();
    const results = await Promise.allSettled([
      ledger.reserveExposure({ limits, intentId: "a", amountUsd: 60, currentSessionId: "session-1", idempotencyKey: "key-a" }),
      ledger.reserveExposure({ limits, intentId: "b", amountUsd: 60, currentSessionId: "session-1", idempotencyKey: "key-b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const snap = await ledger.snapshot();
    expect(snap.reservations.reduce((sum, row) => sum + row.amountUsd, 0)).toBe(60);
  });

  it("makes idempotent retries safe and rejects key reuse for another intent", async () => {
    const ledger = await setup();
    const input = { limits, intentId: "a", amountUsd: 25, currentSessionId: "session-1", idempotencyKey: "same-key" };
    const first = await ledger.reserveExposure(input);
    const retry = await ledger.reserveExposure(input);
    expect(retry.id).toBe(first.id);
    await expect(ledger.reserveExposure({ ...input, intentId: "different" })).rejects.toThrow(/Idempotency key conflicts/);
  });

  it("persists a quote-bound approval and only authorizes it once", async () => {
    const ledger = await setup();
    const intent = makeIntent();
    const reservation = await ledger.reserveExposure({
      limits, intentId: intent.intentId, amountUsd: 40, currentSessionId: "session-1", idempotencyKey: "key-1",
    });
    const approval = await ledger.createApproval(intent, reservation.id, 40);
    await ledger.decideApproval(approval.id, "approved", "operator-1");
    const authorized = await ledger.authorizeOnce({
      approvalId: approval.id, currentIntent: intent, verifiedOperator: { id: "operator-1", canApprove: true },
    });
    expect(authorized.reservation.status).toBe("committed");
    await expect(ledger.authorizeOnce({
      approvalId: approval.id, currentIntent: intent, verifiedOperator: { id: "operator-1", canApprove: true },
    })).rejects.toThrow(/reservation missing, released, or already consumed/);
    const reopened = new TreasuryLedger(join(directory!, "ledger.json"));
    const snap = await reopened.snapshot();
    expect(snap.approvals[0]?.digest).toBe(approval.digest);
    expect(snap.reservations[0]?.status).toBe("committed");
  });

  it("releases reserved exposure when an approval is rejected", async () => {
    const ledger = await setup();
    const intent = makeIntent();
    const reservation = await ledger.reserveExposure({
      limits, intentId: intent.intentId, amountUsd: 40, currentSessionId: "session-1", idempotencyKey: "key-1",
    });
    const approval = await ledger.createApproval(intent, reservation.id, 40);
    await ledger.decideApproval(approval.id, "rejected", "operator-1", "not approved");
    expect((await ledger.snapshot()).reservations[0]?.status).toBe("released");
  });
});
