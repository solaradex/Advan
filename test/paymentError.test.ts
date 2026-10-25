import { describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { GENERIC_PAYMENT_FAILURE, redactPaymentRequired } from "../src/http/paymentError.js";

function header(error: string): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    error,
    accepts: [],
    resource: { url: "http://127.0.0.1/v1/token_risk", description: "risk", mimeType: "application/json" },
  } as PaymentRequired);
}

describe("402 facilitator errors", () => {
  it("replaces a raw facilitator error and keeps an unpaid challenge", () => {
    const raw = header("fetch failed");
    const redacted = redactPaymentRequired(raw);
    expect(redacted.reason).toBe(GENERIC_PAYMENT_FAILURE);
    expect(redacted.header).toBeTypeOf("string");
    expect(decodePaymentRequiredHeader(redacted.header ?? "").error).toBe(GENERIC_PAYMENT_FAILURE);
    expect(redacted.header).not.toContain("fetch failed");

    const unpaid = redactPaymentRequired(header("Payment required"));
    expect(unpaid.reason).toBe("Payment required");
    expect(unpaid.header).toBeUndefined();
  });
});
