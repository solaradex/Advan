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
  /** Facilitator whose `/supported` payload was returned. Payment requirements use that fee payer. */
  active: FacilitatorName = "cdp";

  constructor(
    private readonly primary: FacilitatorClient | null,
    private readonly fallback: FacilitatorClient,
    private readonly network: string,
    private readonly onFailover?: (event: FailoverEvent) => void,
  ) {
    if (!primary) this.active = "payai";
  }

  async getSupported(): Promise<SupportedResponse> {
    if (this.primary) {
      try {
        const supported = await this.primary.getSupported();
        if (supportsExactV2(supported, this.network)) {
          this.active = "cdp";
          this.lastFacilitator = "cdp";
          return supported;
        }
        this.note("supported", "cdp omitted exact v2 for the configured network");
      } catch (error) {
        if (!shouldFailover("supported", error)) throw error;
        this.note("supported", errorText(error));
      }
    }
    this.active = "payai";
    this.lastFacilitator = "payai";
    return this.fallback.getSupported();
  }

  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.call("verify", () => this.primary!.verify(paymentPayload, paymentRequirements), () =>
      this.fallback.verify(paymentPayload, paymentRequirements),
    );
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.call("settle", () => this.primary!.settle(paymentPayload, paymentRequirements), () =>
      this.fallback.settle(paymentPayload, paymentRequirements),
    );
  }

  private async call<T>(
    operation: "verify" | "settle",
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (this.primary && this.active === "cdp") {
      try {
        this.lastFacilitator = "cdp";
        return await primary();
      } catch (error) {
        if (!shouldFailover(operation, error)) throw error;
        this.note(operation, errorText(error));
      }
    }
    this.lastFacilitator = "payai";
    return fallback();
  }

  private note(operation: FacilitatorOperation, error: string): void {
    this.onFailover?.({ operation, from: "cdp", error });
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "facilitator error";
  return message.slice(0, 300);
}
