import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BoundApproval, BoundExecutionIntent } from "./executionGuard.js";
import { createBoundApproval, executionDigest } from "./executionGuard.js";

export interface ExposureLimits {
  wallet: string;
  dailyLimitUsd: number;
  sessionLimitUsd?: number;
}
export interface ExposureReservation {
  id: string;
  wallet: string;
  intentId: string;
  amountUsd: number;
  day: string;
  sessionId: string;
  status: "reserved" | "committed" | "released";
  createdAt: string;
  updatedAt: string;
}
export interface PersistentBoundApproval extends BoundApproval {
  intent: BoundExecutionIntent;
  reservationId: string;
  amountUsd: number;
}
interface LedgerData {
  reservations: Record<string, ExposureReservation>;
  approvals: Record<string, PersistentBoundApproval>;
  idempotency: Record<string, string>;
}
const empty = (): LedgerData => ({ reservations: {}, approvals: {}, idempotency: {} });
const utcDay = () => new Date().toISOString().slice(0, 10);
const finitePositive = (n: number) => Number.isFinite(n) && n > 0;

/**
 * Durable single-host ledger. Exclusive mkdir lock serializes cooperating processes
 * on a shared local filesystem. Do not use on NFS or multiple hosts; use Postgres
 * transactions/advisory locks for multi-replica deployments.
 */
export class TreasuryLedger {
  constructor(private readonly path: string, private readonly lockTimeoutMs = 5_000) {}

  private async read(): Promise<LedgerData> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<LedgerData>;
      return { ...empty(), ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new Error("Treasury ledger unreadable; refusing operation");
    }
  }

  private async locked<T>(work: (data: LedgerData) => T | Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      try {
        await mkdir(lockPath);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Treasury ledger busy; retry safely with the same idempotency key");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      const data = await this.read();
      const result = await work(data);
      const temp = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      await rename(temp, this.path);
      return result;
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async reserveExposure(input: {
    limits: ExposureLimits;
    intentId: string;
    amountUsd: number;
    currentSessionId: string;
    idempotencyKey: string;
  }): Promise<ExposureReservation> {
    const { limits, intentId, amountUsd, currentSessionId, idempotencyKey } = input;
    if (!limits.wallet.trim() || !intentId.trim() || !currentSessionId.trim() || !idempotencyKey.trim()
      || !finitePositive(amountUsd) || !finitePositive(limits.dailyLimitUsd)
      || (limits.sessionLimitUsd != null && !finitePositive(limits.sessionLimitUsd))) {
      throw new Error("Invalid exposure reservation input");
    }
    return this.locked((data) => {
      const key = createHash("sha256").update(`${limits.wallet}: ${idempotencyKey}`).digest("hex");
      const existingId = data.idempotency[key];
      if (existingId) {
        const existing = data.reservations[existingId];
        if (!existing || existing.intentId !== intentId || existing.amountUsd !== amountUsd || existing.status === "released") {
          throw new Error("Idempotency key conflicts with a different or released reservation");
        }
        return existing;
      }
      const day = utcDay();
      const active = Object.values(data.reservations).filter((r) => r.wallet === limits.wallet
        && r.day === day && r.status !== "released");
      const daily = active.reduce((sum, r) => sum + r.amountUsd, 0);
      const session = active.filter((r) => r.sessionId === currentSessionId).reduce((sum, r) => sum + r.amountUsd, 0);
      if (daily + amountUsd > limits.dailyLimitUsd) throw new Error("Daily exposure limit exceeded");
      if (limits.sessionLimitUsd != null && session + amountUsd > limits.sessionLimitUsd) throw new Error("Session exposure limit exceeded");
      const now = new Date().toISOString();
      const reservation: ExposureReservation = {
        id: randomUUID(), wallet: limits.wallet, intentId, amountUsd, day, sessionId: currentSessionId,
        status: "reserved", createdAt: now, updatedAt: now,
      };
      data.reservations[reservation.id] = reservation;
      data.idempotency[key] = reservation.id;
      return reservation;
    });
  }

  async createApproval(intent: BoundExecutionIntent, reservationId: string, amountUsd: number): Promise<PersistentBoundApproval> {
    return this.locked((data) => {
      const reservation = data.reservations[reservationId];
      if (!reservation || reservation.status !== "reserved" || reservation.intentId !== intent.intentId
        || reservation.wallet !== intent.wallet || reservation.amountUsd !== amountUsd) {
        throw new Error("An active matching exposure reservation is required");
      }
      const bound = createBoundApproval(intent);
      const approval: PersistentBoundApproval = { ...bound, intent: structuredClone(intent), reservationId, amountUsd };
      data.approvals[approval.id] = approval;
      return approval;
    });
  }

  async decideApproval(id: string, status: "approved" | "rejected", operatorId: string, reason?: string): Promise<PersistentBoundApproval> {
    if (!operatorId.trim()) throw new Error("Verified operator ID required");
    return this.locked((data) => {
      const old = data.approvals[id];
      if (!old || old.status !== "pending") throw new Error("Approval not found or already decided");
      const expired = Date.parse(old.expiresAt) <= Date.now();
      const finalStatus = expired ? "rejected" : status;
      const next: PersistentBoundApproval = {
        ...old, status: finalStatus, decidedAt: new Date().toISOString(),
        decidedBy: expired ? undefined : operatorId, reason: expired ? "expired" : reason,
      };
      if (expired) {
        const reservation = data.reservations[old.reservationId];
        if (reservation?.status === "reserved") data.reservations[reservation.id] = { ...reservation, status: "released", updatedAt: new Date().toISOString() };
      }
      data.approvals[id] = next;
      if (finalStatus === "rejected" && !expired) {
        const reservation = data.reservations[old.reservationId];
        if (reservation?.status === "reserved") data.reservations[reservation.id] = { ...reservation, status: "released", updatedAt: new Date().toISOString() };
      }
      return next;
    });
  }

  async authorizeOnce(input: {
    approvalId: string;
    currentIntent: BoundExecutionIntent;
    verifiedOperator: { id: string; canApprove: boolean } | null;
  }): Promise<{ approval: PersistentBoundApproval; reservation: ExposureReservation }> {
    return this.locked((data) => {
      const approval = data.approvals[input.approvalId];
      if (!approval || approval.status !== "approved") throw new Error("Approved persistent intent not found");
      if (!input.verifiedOperator?.canApprove || !input.verifiedOperator.id
        || approval.decidedBy !== input.verifiedOperator.id) throw new Error("Verified authorized approver required");
      if (Date.parse(approval.expiresAt) <= Date.now()
        || approval.digest !== executionDigest(input.currentIntent)
        || approval.intentId !== input.currentIntent.intentId
        || approval.policyId !== input.currentIntent.policyId
        || approval.wallet !== input.currentIntent.wallet) throw new Error("Approved intent changed or expired");
      const reservation = data.reservations[approval.reservationId];
      if (!reservation || reservation.status !== "reserved" || reservation.intentId !== approval.intentId) {
        throw new Error("Exposure reservation missing, released, or already consumed");
      }
      const now = new Date().toISOString();
      const consumed: PersistentBoundApproval = { ...approval, status: "approved", reason: approval.reason };
      const committed: ExposureReservation = { ...reservation, status: "committed", updatedAt: now };
      data.approvals[approval.id] = consumed;
      data.reservations[reservation.id] = committed;
      return { approval: consumed, reservation: committed };
    });
  }

  async releaseReservation(id: string): Promise<ExposureReservation> {
    return this.locked((data) => {
      const old = data.reservations[id];
      if (!old || old.status !== "reserved") throw new Error("Reservation not found or no longer releasable");
      const next = { ...old, status: "released" as const, updatedAt: new Date().toISOString() };
      data.reservations[id] = next;
      return next;
    });
  }

  async snapshot(): Promise<{ reservations: ExposureReservation[]; approvals: PersistentBoundApproval[] }> {
    return this.locked((data) => ({ reservations: Object.values(data.reservations), approvals: Object.values(data.approvals) }));
  }
}
