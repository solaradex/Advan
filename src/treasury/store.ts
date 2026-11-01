import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TreasuryPolicy } from "./policy.js";

export interface TreasuryApproval {
  id: string;
  intentId: string;
  policyId: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}
interface StoreData {
  policies: Record<string, TreasuryPolicy>;
  approvals: Record<string, TreasuryApproval>;
}
const empty = (): StoreData => ({ policies: {}, approvals: {} });

export function bearerAuthorized(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

/** Local durable MVP store. Single-process only; use a transactional DB for multi-replica deployment. */
export class TreasuryStore {
  constructor(private readonly path: string) {}
  private read(): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoreData;
      return { ...empty(), ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new Error("Treasury store is unreadable; refusing to continue");
    }
  }
  private write(data: StoreData): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    renameSync(temp, this.path);
  }
  putPolicy(policy: TreasuryPolicy): void {
    const data = this.read();
    data.policies[policy.id] = policy;
    this.write(data);
  }
  getPolicy(id: string): TreasuryPolicy | undefined { return this.read().policies[id]; }
  createApproval(intentId: string, policyId: string): TreasuryApproval {
    const data = this.read();
    const approval: TreasuryApproval = { id: randomUUID(), intentId, policyId, status: "pending", requestedAt: new Date().toISOString() };
    data.approvals[approval.id] = approval;
    this.write(data);
    return approval;
  }
  decideApproval(id: string, status: "approved" | "rejected", decidedBy: string, reason?: string): TreasuryApproval {
    const data = this.read();
    const old = data.approvals[id];
    if (!old || old.status !== "pending") throw new Error("Approval not found or already decided");
    const next = { ...old, status, decidedAt: new Date().toISOString(), decidedBy, reason };
    data.approvals[id] = next;
    this.write(data);
    return next;
  }
  listApprovals(): TreasuryApproval[] { return Object.values(this.read().approvals); }
  appendAudit(event: unknown): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(`${this.path}.audit.jsonl`, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
}
