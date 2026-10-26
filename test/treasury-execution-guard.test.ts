import { describe, expect, it } from "vitest";
import { assertExecutionAuthorized, createBoundApproval, type BoundExecutionIntent } from "../src/treasury/executionGuard.js";

const intent = (): BoundExecutionIntent => ({
  intentId: "intent-1",
  policyId: "policy-1",
  wallet: "wallet-1",
  inputMint: "mint-in",
  outputMint: "mint-out",
  amount: "25.00",
  quoteResponse: { outAmount: "123", routePlan: [{ swapInfo: { label: "route-a" } }] },
  transactionMessageDigest: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

describe("quote-bound execution guard", () => {
  it("rejects pending approvals", () => {
    const i = intent();
    const approval = createBoundApproval(i);
    expect(() => assertExecutionAuthorized(approval, i, { id: "operator-1", canApprove: true })).toThrow(/not approved/);
  });

  it("rejects changed quote or transaction intent", () => {
    const i = intent();
    const approval = { ...createBoundApproval(i), status: "approved" as const, decidedBy: "operator-1" };
    const changed = { ...i, quoteResponse: { outAmount: "1" } };
    expect(() => assertExecutionAuthorized(approval, changed, { id: "operator-1", canApprove: true })).toThrow(/changed/);
  });

  it("requires a verified authorized approver matching the decision", () => {
    const i = intent();
    const approval = { ...createBoundApproval(i), status: "approved" as const, decidedBy: "operator-1" };
    expect(() => assertExecutionAuthorized(approval, i, null)).toThrow(/verified authorized approver/);
    expect(() => assertExecutionAuthorized(approval, i, { id: "operator-2", canApprove: true })).toThrow(/verified authorized approver/);
    expect(() => assertExecutionAuthorized(approval, i, { id: "operator-1", canApprove: true })).not.toThrow();
  });

  it("rejects expired intents and missing transaction digests", () => {
    expect(() => createBoundApproval({ ...intent(), transactionMessageDigest: "bad" })).toThrow(/incomplete or expired/);
    const i = intent();
    const approval = { ...createBoundApproval(i), status: "approved" as const, decidedBy: "operator-1", expiresAt: new Date(Date.now() - 1).toISOString() };
    expect(() => assertExecutionAuthorized(approval, i, { id: "operator-1", canApprove: true })).toThrow(/expired/);
  });
});
