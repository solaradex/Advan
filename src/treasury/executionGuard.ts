import { createHash, randomUUID } from "node:crypto";
export interface BoundExecutionIntent {
  intentId: string;
  policyId: string;
  wallet: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  quoteResponse: unknown;
  transactionMessageDigest: string;
  expiresAt: string;
}

export interface BoundApproval {
  id: string;
  intentId: string;
  policyId: string;
  wallet: string;
  digest: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

export function executionDigest(intent: BoundExecutionIntent): string {
  return createHash("sha256").update(canonical(intent)).digest("hex");
}

/**
 * Creates an approval binding for an exact quote and transaction message.
 * This is a pure safety primitive: persistence, identity verification, transaction
 * decoding, signing and broadcast must be supplied by the calling service.
 */
export function createBoundApproval(intent: BoundExecutionIntent): BoundApproval {
  const expiry = Date.parse(intent.expiresAt);
  if (!intent.intentId.trim() || !intent.policyId.trim() || !intent.wallet.trim()
    || !intent.inputMint.trim() || !intent.outputMint.trim() || !intent.amount.trim()
    || !/^[a-f0-9]{64}$/i.test(intent.transactionMessageDigest)
    || !Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error("Execution intent is incomplete or expired");
  }
  return {
    id: randomUUID(),
    intentId: intent.intentId,
    policyId: intent.policyId,
    wallet: intent.wallet,
    digest: executionDigest(intent),
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: intent.expiresAt,
  };
}

export function assertExecutionAuthorized(
  approval: BoundApproval,
  intent: BoundExecutionIntent,
  verifiedOperator: { id: string; canApprove: boolean } | null,
): void {
  if (approval.status !== "approved") throw new Error("Execution approval is not approved");
  if (!verifiedOperator?.id || !verifiedOperator.canApprove || approval.decidedBy !== verifiedOperator.id) {
    throw new Error("A verified authorized approver is required");
  }
  if (Date.parse(intent.expiresAt) <= Date.now() || Date.parse(approval.expiresAt) <= Date.now()) {
    throw new Error("Execution intent or approval has expired");
  }
  if (approval.intentId !== intent.intentId || approval.policyId !== intent.policyId
    || approval.wallet !== intent.wallet || approval.digest !== executionDigest(intent)) {
    throw new Error("Approved intent, quote, wallet, or transaction changed");
  }
}
