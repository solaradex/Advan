import type { BoundExecutionIntent } from "./executionGuard.js";
import { executionDigest } from "./executionGuard.js";

export interface PgReservation {
  id: string; wallet: string; intent_id: string; session_id: string; idempotency_key: string;
  amount_usd: number; status: "reserved" | "committed" | "released"; utc_day: string;
}
export interface PgApproval {
  id: string; intent_id: string; policy_id: string; wallet: string; intent_digest: string;
  transaction_message_digest: string; quote_json: unknown; intent_json: BoundExecutionIntent;
  reservation_id: string; amount_usd: number; status: "pending" | "approved" | "rejected" | "consumed" | "expired";
  expires_at: string; decided_at?: string; decided_by?: string; decision_reason?: string;
}
export interface TreasuryPgConfig { supabaseUrl: string; serviceRoleKey: string; }

/** Server-only PostgREST adapter. Never construct this in browser code. */
export class TreasuryPgAdapter {
  private readonly base: string;
  constructor(config: TreasuryPgConfig) {
    if (!config.supabaseUrl.startsWith("https://") || !config.serviceRoleKey.trim()) {
      throw new Error("Treasury PostgreSQL adapter requires a Supabase HTTPS URL and service-role key");
    }
    this.base = config.supabaseUrl.replace(/\/$/, "");
    this.key = config.serviceRoleKey;
  }
  private readonly key: string;
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.base}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Treasury database request failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async reserveExposure(input: {
    wallet: string; intentId: string; sessionId: string; idempotencyKey: string;
    amountUsd: number; dailyLimitUsd: number; sessionLimitUsd?: number;
  }): Promise<PgReservation> {
    const rows = await this.request<PgReservation[]>("rpc/treasury_reserve_exposure", {
      method: "POST",
      body: JSON.stringify({
        p_wallet: input.wallet, p_intent_id: input.intentId, p_session_id: input.sessionId,
        p_idempotency_key: input.idempotencyKey, p_amount_usd: input.amountUsd,
        p_daily_limit_usd: input.dailyLimitUsd, p_session_limit_usd: input.sessionLimitUsd ?? null,
      }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows as unknown as PgReservation;
    if (!row?.id) throw new Error("Treasury reservation RPC returned no reservation");
    return row;
  }

  async createApproval(input: {
    intent: BoundExecutionIntent; reservationId: string; amountUsd: number; ttlSeconds?: number;
  }): Promise<PgApproval> {
    const ttl = input.ttlSeconds ?? 300;
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 1800 || !Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
      throw new Error("Invalid approval TTL or amount");
    }
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const payload = {
      intent_id: input.intent.intentId, policy_id: input.intent.policyId, wallet: input.intent.wallet,
      intent_digest: executionDigest(input.intent), transaction_message_digest: input.intent.transactionMessageDigest,
      quote_json: input.intent.quoteResponse, intent_json: input.intent, reservation_id: input.reservationId,
      amount_usd: input.amountUsd, expires_at: expiresAt, status: "pending",
    };
    const rows = await this.request<PgApproval[]>("treasury_bound_approvals", {
      method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(payload),
    });
    if (!rows[0]?.id) throw new Error("Treasury approval insert returned no approval");
    return rows[0];
  }

  async getApproval(id: string): Promise<PgApproval | null> {
    const rows = await this.request<PgApproval[]>(`treasury_bound_approvals?id=eq.${encodeURIComponent(id)}&select=*`);
    return rows[0] ?? null;
  }

  async decideApproval(input: { id: string; status: "approved" | "rejected"; verifiedOperatorId: string; reason?: string }): Promise<PgApproval> {
    if (!input.verifiedOperatorId.trim()) throw new Error("Verified operator identity required");
    const rows = await this.request<PgApproval[]>("rpc/treasury_decide_approval", {
      method: "POST",
      body: JSON.stringify({
        p_approval_id: input.id, p_status: input.status,
        p_verified_operator_id: input.verifiedOperatorId, p_reason: input.reason ?? null,
      }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows as unknown as PgApproval;
    if (!row?.id) throw new Error("Treasury decision RPC returned no approval");
    return row;
  }

  async consumeApproval(input: {
    approvalId: string; currentIntent: BoundExecutionIntent; verifiedOperatorId: string;
  }): Promise<PgApproval> {
    const rows = await this.request<PgApproval[]>("rpc/treasury_consume_approval", {
      method: "POST",
      body: JSON.stringify({
        p_approval_id: input.approvalId, p_verified_operator_id: input.verifiedOperatorId,
        p_current_intent_digest: executionDigest(input.currentIntent),
        p_current_transaction_message_digest: input.currentIntent.transactionMessageDigest,
      }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows as unknown as PgApproval;
    if (!row?.id) throw new Error("Treasury consume RPC returned no approval");
    return row;
  }

  async listPendingApprovals(wallet?: string): Promise<PgApproval[]> {
    const query = new URLSearchParams({ select: "*", status: "eq.pending", expires_at: `gt.${new Date().toISOString()}`, order: "created_at.asc" });
    if (wallet) query.set("wallet", `eq.${wallet}`);
    return this.request<PgApproval[]>(`treasury_bound_approvals?${query.toString()}`);
  }
}
