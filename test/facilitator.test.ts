import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { SOLANA_DEVNET_CAIP } from "../src/constants.js";
import {
  FallbackFacilitatorClient,
  httpStatusFromError,
  isDefiniteNonSubmission,
  shouldFailover,
} from "../src/x402/fallbackFacilitator.js";

const payload = {} as PaymentPayload;
const requirements = {} as PaymentRequirements;

function supported(network: Network = SOLANA_DEVNET_CAIP): SupportedResponse {
  return {
    kinds: [{ x402Version: 2, scheme: "exact", network }],
    extensions: [],
    signers: {},
  };
}

class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  supportedCalls = 0;

  constructor(
    private readonly behavior: {
      supported?: SupportedResponse | Error;
      verify?: VerifyResponse | Error;
      settle?: SettleResponse | Error;
    } = {},
  ) {}

  async getSupported(): Promise<SupportedResponse> {
    this.supportedCalls += 1;
    return unwrap(this.behavior.supported ?? supported());
  }

  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return unwrap(this.behavior.verify ?? { isValid: true, payer: "payer" });
  }

  async settle(): Promise<SettleResponse> {
    this.settleCalls += 1;
    return unwrap(
      this.behavior.settle ?? { success: true, transaction: "sig", network: SOLANA_DEVNET_CAIP, payer: "payer" },
    );
  }
}

function unwrap<T>(value: T | Error): T {
  if (value instanceof Error) throw value;
  return value;
}

function httpError(status: number): Error {
  return new Error(`Facilitator request failed (${status}): no`);
}

function connectError(): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: { code: string } }).cause = { code: "ECONNREFUSED" };
  return error;
}

describe("facilitator fallback policy", () => {
  it("classifies connect failures, timeouts, and HTTP statuses", () => {
    expect(isDefiniteNonSubmission(connectError())).toBe(true);
    expect(isDefiniteNonSubmission(httpError(500))).toBe(false);
    const timeout = new Error("timed out");
    timeout.name = "FacilitatorTimeoutError";
    expect(shouldFailover("verify", timeout)).toBe(true);
    expect(shouldFailover("settle", timeout)).toBe(false);
    expect(shouldFailover("verify", httpError(500))).toBe(true);
    expect(shouldFailover("verify", httpError(401))).toBe(true);
    expect(shouldFailover("settle", httpError(500))).toBe(false);
    expect(shouldFailover("settle", httpError(401))).toBe(true);
    expect(shouldFailover("settle", connectError())).toBe(true);
    expect(httpStatusFromError(httpError(503))).toBe(503);
  });

  it("uses PayAI when CDP /supported fails and keeps CDP when it lists the network", async () => {
    const down = new FakeFacilitator({ supported: httpError(502) });
    const payai = new FakeFacilitator();
    const client = new FallbackFacilitatorClient(down, payai, SOLANA_DEVNET_CAIP);
    await client.getSupported();
    expect(payai.supportedCalls).toBe(1);
    expect(client.active).toBe("payai");

    const healthy = new FakeFacilitator();
    const unused = new FakeFacilitator();
    const pinned = new FallbackFacilitatorClient(healthy, unused, SOLANA_DEVNET_CAIP);
    await pinned.getSupported();
    expect(unused.supportedCalls).toBe(0);
    expect(pinned.active).toBe("cdp");
  });

  it("falls back on verify server errors and does not retry a settle that reached CDP", async () => {
    const primary = new FakeFacilitator({ verify: httpError(500), settle: httpError(500) });
    const payai = new FakeFacilitator();
    const client = new FallbackFacilitatorClient(primary, payai, SOLANA_DEVNET_CAIP);
    await expect(client.verify(payload, requirements)).resolves.toMatchObject({ isValid: true });
    expect(payai.verifyCalls).toBe(1);
    await expect(client.settle(payload, requirements)).rejects.toThrow(/500/);
    expect(payai.settleCalls).toBe(0);
  });

  it("retries settle only when the request did not submit, including connect failure", async () => {
    const refused = new FakeFacilitator({ settle: connectError() });
    const payai = new FakeFacilitator();
    const client = new FallbackFacilitatorClient(refused, payai, SOLANA_DEVNET_CAIP);
    await expect(client.settle(payload, requirements)).resolves.toMatchObject({ success: true });
    expect(payai.settleCalls).toBe(1);

    const timeout = new Error("settle timed out");
    timeout.name = "FacilitatorTimeoutError";
    const slow = new FakeFacilitator({ settle: timeout });
    const other = new FakeFacilitator();
    const stuck = new FallbackFacilitatorClient(slow, other, SOLANA_DEVNET_CAIP);
    await expect(stuck.settle(payload, requirements)).rejects.toThrow(/timed out/);
    expect(other.settleCalls).toBe(0);
  });

  it("falls back when CDP does not advertise exact v2 for the network", async () => {
    const primary = new FakeFacilitator({
      supported: { kinds: [{ x402Version: 1, scheme: "exact", network: SOLANA_DEVNET_CAIP }], extensions: [], signers: {} },
    });
    const payai = new FakeFacilitator();
    const events: string[] = [];
    const client = new FallbackFacilitatorClient(primary, payai, SOLANA_DEVNET_CAIP, (event) => {
      events.push(event.error);
    });
    await client.getSupported();
    expect(client.active).toBe("payai");
    expect(events[0]).toMatch(/omitted exact v2/);
  });
});
