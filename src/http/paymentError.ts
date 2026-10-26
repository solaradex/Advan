import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";

/** Client-facing text when verification fails. Facilitator detail stays in the usage log. */
export const GENERIC_PAYMENT_FAILURE = "payment could not be verified";

export interface RedactedPaymentRequired {
  /** Replacement `PAYMENT-REQUIRED` header. Omitted when the original can stay. */
  header?: string;
  /** Value safe to put in the 402 JSON body. */
  reason?: string;
}

/**
 * Replace a facilitator error in a 402 (`fetch failed`, simulation text, and
 * the rest) with a generic reason. An unpaid challenge (`Payment required`)
 * is left as the SDK wrote it.
 */
export function redactPaymentRequired(header: string | number | string[] | undefined): RedactedPaymentRequired {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const decoded = decodePaymentRequiredHeader(value);
    const raw = typeof decoded.error === "string" ? decoded.error : undefined;
    if (!raw || raw === "Payment required") return { reason: raw };
    return {
      header: encodePaymentRequiredHeader({ ...decoded, error: GENERIC_PAYMENT_FAILURE }),
      reason: GENERIC_PAYMENT_FAILURE,
    };
  } catch {
    return { reason: GENERIC_PAYMENT_FAILURE };
  }
}
