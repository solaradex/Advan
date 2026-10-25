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

export class FallbackFacilitatorClient implements FacilitatorClient {
  lastFacilitator: FacilitatorName | "none" = "none";
  /** Facilitator whose `/supported` payload was returned. New payment requirements use that fee payer. */
  active: FacilitatorName = "cdp";
  private readonly feePayers = new Map<FacilitatorName, string>();
  private readonly down = new Set<FacilitatorName>();

  constructor(
    private readonly primary: FacilitatorClient | null,
    private readonly fallback: FacilitatorClient,
    private readonly network: string,
    private readonly onFailover?: (event: FailoverEvent) => void,
    /** Called after `active` moves to the other facilitator so requirements can be rebuilt. */
    private readonly onActiveChange?: () => Promise<void>,
  ) {
    if (!primary) this.active = "payai";
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
        this.down.add("cdp");
      } catch (error) {
        if (!shouldFailover("supported", error)) throw error;
        this.note("supported", errorText(error));
        this.down.add("cdp");
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
        this.down.add("cdp");
        if (this.active === "cdp") {
          this.active = "payai";
          try {
            await this.onActiveChange?.();
          } catch (hookError) {
            const message = hookError instanceof Error ? hookError.message : "refresh failed";
            process.stderr.write(`advan: facilitator refresh failed: ${message}\n`);
          }
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
    for (const [name, payer] of this.feePayers) {
      if (payer === feePayer) return name;
    }
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
    const payer = feePayerFromSupported(supported, this.network);
    if (payer) this.feePayers.set(name, payer);
  }

  private note(operation: FacilitatorOperation, error: string): void {
    this.onFailover?.({ operation, from: "cdp", error });
  }
}

function feePayerOf(requirements: PaymentRequirements): string | undefined {
  const value = requirements.extra?.feePayer;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function feePayerFromSupported(supported: SupportedResponse, network: string): string | undefined {
  const kind = supported.kinds.find(
    (item) => item.scheme === "exact" && item.network === network && item.x402Version === 2,
  );
  const extra = kind?.extra as { feePayer?: unknown } | undefined;
  return typeof extra?.feePayer === "string" ? extra.feePayer : undefined;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "facilitator error";
  return message.slice(0, 300);
}
