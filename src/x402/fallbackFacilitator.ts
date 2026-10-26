import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

export type FacilitatorName = "cdp" | "payai";
export type FacilitatorOperation = "verify" | "settle" | "supported";

const CONNECT_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface FailoverEvent {
  operation: FacilitatorOperation;
  from: FacilitatorName;
  error: string;
}

function causeCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof record.code === "string") return record.code;
  if (typeof record.cause?.code === "string") return record.cause.code;
  return undefined;
}

export function httpStatusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { statusCode?: unknown; status?: unknown; message?: unknown };
  if (typeof record.statusCode === "number") return record.statusCode;
  if (typeof record.status === "number") return record.status;
  if (typeof record.message === "string") {
    const match = record.message.match(/\((\d{3})\)/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** True when the facilitator never accepted the HTTP request. */
export function isDefiniteNonSubmission(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  if (name === "FacilitatorTimeoutError" || name === "SettleError" || name === "VerifyError") return false;
  const code = causeCode(error);
  return Boolean(code && CONNECT_CODES.has(code));
}

/**
 * Verify and `/supported` may move to the fallback on network errors, timeouts,
 * 401/403, 429, and 5xx. Settle moves only when the request did not reach the
 * facilitator (connect failure) or auth was rejected before processing (401/403).
 * A settle timeout or 5xx may mean the transaction landed, so it is not retried.
 */
export function shouldFailover(operation: FacilitatorOperation, error: unknown): boolean {
  if (isDefiniteNonSubmission(error)) return true;
  const status = httpStatusFromError(error);
  const timeout = (error as { name?: string }).name === "FacilitatorTimeoutError";
  if (operation === "settle") return status === 401 || status === 403;
  if (timeout) return true;
  if (status != null && (status >= 500 || status === 401 || status === 403 || status === 429)) return true;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  return false;
}

export function supportsExactV2(supported: SupportedResponse, network: string): boolean {
  return supported.kinds.some((kind) => kind.scheme === "exact" && kind.network === network && kind.x402Version === 2);
}

/** How long after CDP is marked down the next probe runs. Override with `X402_CDP_RECOVERY_INTERVAL_MS`. */
export const CDP_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** Bound on rebuilding payment requirements after a probe, so a stuck initialize cannot wedge the server. */
export const CDP_REFRESH_TIMEOUT_MS = 15_000;

export interface FacilitatorRecoveryOptions {
  recoveryIntervalMs?: number;
  refreshTimeoutMs?: number;
  onRecovered?: () => void;
}

export interface FacilitatorHealth {
  active: FacilitatorName;
  cdp: "unconfigured" | "primary" | "down";
  cdpNextProbeAt: string | null;
}

export class FallbackFacilitatorClient implements FacilitatorClient {
  lastFacilitator: FacilitatorName | "none" = "none";
  /** Facilitator whose `/supported` payload was returned. New payment requirements use that fee payer. */
  active: FacilitatorName = "cdp";
  /** Every fee payer ever advertised by that facilitator. A rotation does not drop the previous one. */
  private readonly feePayers = new Map<FacilitatorName, Set<string>>();
  private readonly down = new Set<FacilitatorName>();
  private cdpNextProbeAtMs?: number;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  /** Set only while the CDP `/supported` check is in flight. `getSupported` must not wait on it. */
  private recoveryCheck?: Promise<unknown>;
  private readonly recoveryIntervalMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly onRecovered?: () => void;

  constructor(
    private readonly primary: FacilitatorClient | null,
    private readonly fallback: FacilitatorClient,
    private readonly network: string,
    private readonly onFailover?: (event: FailoverEvent) => void,
    /** Called after `active` moves so the resource server reloads that facilitator's kinds. */
    private readonly onActiveChange?: () => Promise<void>,
    options: FacilitatorRecoveryOptions = {},
  ) {
    if (!primary) this.active = "payai";
    this.recoveryIntervalMs = options.recoveryIntervalMs ?? CDP_RECOVERY_INTERVAL_MS;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? CDP_REFRESH_TIMEOUT_MS;
    this.onRecovered = options.onRecovered;
  }

  /** Milliseconds when the next CDP probe is allowed. Undefined while CDP is primary. */
  get nextCdpProbeAt(): number | undefined {
    return this.cdpNextProbeAtMs;
  }

  health(): FacilitatorHealth {
    if (!this.primary) return { active: this.active, cdp: "unconfigured", cdpNextProbeAt: null };
    if (this.down.has("cdp")) {
      return {
        active: this.active,
        cdp: "down",
        cdpNextProbeAt: this.cdpNextProbeAtMs == null ? null : new Date(this.cdpNextProbeAtMs).toISOString(),
      };
    }
    return { active: this.active, cdp: "primary", cdpNextProbeAt: null };
  }

  /**
   * Arm the one-shot timer when CDP is already down (startup failover).
   * Later failures arm themselves. Does not keep the process alive.
   */
  startRecoveryProbe(): void {
    if (!this.primary || !this.down.has("cdp")) return;
    this.armRecoveryTimer();
  }

  /**
   * Ask CDP `/supported` at `failureTime + interval`. A healthy answer reloads
   * the resource server outside this check so `getSupported` cannot deadlock on it.
   * A failed reload marks CDP down again and reloads PayAI.
   */
  async probeRecovery(now = Date.now()): Promise<"skipped" | "still_down" | "restored"> {
    if (this.recoveryCheck) return "skipped";
    const check = this.evaluateCdp(now);
    this.recoveryCheck = check;
    let evaluation: "skipped" | "still_down" | "healthy";
    try {
      evaluation = await check;
    } finally {
      if (this.recoveryCheck === check) this.recoveryCheck = undefined;
    }
    if (evaluation !== "healthy") return evaluation;
    const restored = await this.finishRestore();
    return restored ? "restored" : "still_down";
  }

  async getSupported(): Promise<SupportedResponse> {
    if (this.primary && this.active === "cdp" && !this.down.has("cdp")) {
      try {
        const supported = await this.primary.getSupported();
        if (supportsExactV2(supported, this.network)) {
          this.remember("cdp", supported);
          this.active = "cdp";
          this.lastFacilitator = "cdp";
          await this.learnFeePayer("payai");
          return supported;
        }
        this.note("supported", "cdp omitted exact v2 for the configured network");
        this.markCdpDown();
      } catch (error) {
        if (!shouldFailover("supported", error)) throw error;
        this.note("supported", errorText(error));
        this.markCdpDown();
      }
    }
    this.active = "payai";
    this.lastFacilitator = "payai";
    const supported = await this.fallback.getSupported();
    this.remember("payai", supported);
    return supported;
  }

  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.dispatch("verify", paymentPayload, paymentRequirements);
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.dispatch("settle", paymentPayload, paymentRequirements);
  }

  /**
   * Verify and settle go to the facilitator that advertised `requirements.extra.feePayer`.
   * The other facilitator cannot co-sign or settle that transaction. A failover-eligible
   * failure marks CDP down and rebuilds later requirements around PayAI.
   */
  private async dispatch<T>(
    operation: "verify" | "settle",
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<T> {
    const name = await this.facilitatorFor(paymentRequirements);
    try {
      this.lastFacilitator = name;
      return await this.invoke<T>(name, operation, paymentPayload, paymentRequirements);
    } catch (error) {
      if (name === "cdp" && this.primary && shouldFailover(operation, error)) {
        this.note(operation, errorText(error));
        this.markCdpDown();
        if (this.active === "cdp") {
          this.active = "payai";
          await this.reloadActive("PayAI failover");
        }
      }
      throw error;
    }
  }

  private async facilitatorFor(requirements: PaymentRequirements): Promise<FacilitatorName> {
    const feePayer = feePayerOf(requirements);
    if (!feePayer) return this.active === "cdp" && this.primary && !this.down.has("cdp") ? "cdp" : "payai";
    const known = this.ownerOf(feePayer);
    if (known) return known;
    if (!this.feePayers.has("payai")) await this.learnFeePayer("payai");
    return this.ownerOf(feePayer) ?? this.active;
  }

  private ownerOf(feePayer: string): FacilitatorName | undefined {
    if (this.feePayers.get("cdp")?.has(feePayer)) return "cdp";
    if (this.feePayers.get("payai")?.has(feePayer)) return "payai";
    return undefined;
  }

  private async invoke<T>(
    name: FacilitatorName,
    operation: "verify" | "settle",
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<T> {
    const client = name === "cdp" ? this.primary : this.fallback;
    if (!client) throw new Error("CDP facilitator is not configured");
    const result = await client[operation](paymentPayload, paymentRequirements);
    return result as T;
  }

  private async learnFeePayer(name: FacilitatorName): Promise<void> {
    if (name === "cdp" && !this.primary) return;
    try {
      const client = name === "cdp" ? this.primary : this.fallback;
      if (!client) return;
      const supported = await client.getSupported();
      if (supportsExactV2(supported, this.network)) this.remember(name, supported);
    } catch {
      // The fee payer is learned again on the next successful /supported.
    }
  }

  private remember(name: FacilitatorName, supported: SupportedResponse): void {
    const payers = feePayersFromSupported(supported, this.network);
    if (payers.length === 0) return;
    const known = this.feePayers.get(name) ?? new Set<string>();
    for (const payer of payers) known.add(payer);
    this.feePayers.set(name, known);
  }

  private note(operation: FacilitatorOperation, error: string): void {
    this.onFailover?.({ operation, from: "cdp", error });
  }

  /** The first failure schedules one probe at now + interval. Later failures do not push it back. */
  private markCdpDown(now = Date.now()): void {
    const first = !this.down.has("cdp");
    this.down.add("cdp");
    if (!first) return;
    this.cdpNextProbeAtMs = now + this.recoveryIntervalMs;
    this.armRecoveryTimer();
  }

  private armRecoveryTimer(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    if (!this.down.has("cdp") || this.cdpNextProbeAtMs == null) return;
    const delay = Math.max(0, this.cdpNextProbeAtMs - Date.now());
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.probeRecovery();
    }, delay);
    this.recoveryTimer.unref?.();
  }

  private postponeProbe(now: number, message: string): void {
    this.cdpNextProbeAtMs = now + this.recoveryIntervalMs;
    this.armRecoveryTimer();
    process.stderr.write(`advan: ${message}; next probe ${new Date(this.cdpNextProbeAtMs).toISOString()}\n`);
  }

  /**
   * Read CDP `/supported` only. Does not reload the resource server.
   * On success, CDP is already the active facilitator so the reload's `getSupported` returns CDP.
   */
  private async evaluateCdp(now: number): Promise<"skipped" | "still_down" | "healthy"> {
    if (!this.primary || !this.down.has("cdp")) return "skipped";
    if (this.cdpNextProbeAtMs != null && now < this.cdpNextProbeAtMs) return "skipped";
    try {
      const supported = await this.primary.getSupported();
      if (!supportsExactV2(supported, this.network)) {
        this.postponeProbe(now, "CDP facilitator still does not list exact v2");
        return "still_down";
      }
      this.remember("cdp", supported);
      this.down.delete("cdp");
      this.cdpNextProbeAtMs = undefined;
      this.active = "cdp";
      this.lastFacilitator = "cdp";
      return "healthy";
    } catch (error) {
      this.postponeProbe(now, `CDP facilitator still unavailable (${errorText(error)})`);
      return "still_down";
    }
  }

  /** Reload requirements after the check promise has finished, so this cannot wait on itself. */
  private async finishRestore(): Promise<boolean> {
    const reloaded = await this.reloadActive("CDP restore");
    if (reloaded) {
      this.onRecovered?.();
      process.stderr.write("advan: CDP facilitator is healthy again; new payment challenges use CDP\n");
      return true;
    }
    process.stderr.write("advan: CDP restore failed; reverting to PayAI\n");
    this.active = "payai";
    this.lastFacilitator = "payai";
    this.down.add("cdp");
    this.cdpNextProbeAtMs = Date.now() + this.recoveryIntervalMs;
    this.armRecoveryTimer();
    await this.reloadActive("PayAI reload after a failed CDP restore");
    return false;
  }

  private async reloadActive(label: string): Promise<boolean> {
    try {
      await withTimeout(this.onActiveChange?.() ?? Promise.resolve(), this.refreshTimeoutMs);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "refresh failed";
      process.stderr.write(`advan: ${label} failed (${message})\n`);
      return false;
    }
  }
}

function feePayerOf(requirements: PaymentRequirements): string | undefined {
  const value = requirements.extra?.feePayer;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Every fee payer a facilitator listed for this network. Kinds accumulate across probes. */
export function feePayersFromSupported(supported: SupportedResponse, network: string): string[] {
  const found = new Set<string>();
  for (const kind of supported.kinds) {
    if (kind.network !== network) continue;
    const extra = kind.extra as { feePayer?: unknown; feePayers?: unknown } | undefined;
    addPayer(found, extra?.feePayer);
    addPayer(found, extra?.feePayers);
  }
  return [...found];
}

function addPayer(found: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    found.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) addPayer(found, item);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`facilitator refresh timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("facilitator refresh failed"));
      },
    );
  });
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "facilitator error";
  return message.slice(0, 300);
}
