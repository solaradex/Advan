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
  CDP_RECOVERY_INTERVAL_MS,
  FallbackFacilitatorClient,
  httpStatusFromError,
  isDefiniteNonSubmission,
  shouldFailover,
} from "../src/x402/fallbackFacilitator.js";

const payload = {} as PaymentPayload;

function supported(network: Network = SOLANA_DEVNET_CAIP, feePayer = "CDP_FEE"): SupportedResponse {
  return {
    kinds: [{ x402Version: 2, scheme: "exact", network, extra: { feePayer } }],
    extensions: [],
    signers: {},
  };
}

function priced(feePayer: string): PaymentRequirements {
  return { extra: { feePayer } } as unknown as PaymentRequirements;
}

class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  supportedCalls = 0;

  constructor(
    readonly behavior: {
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

    const healthy = new FakeFacilitator({ supported: supported(SOLANA_DEVNET_CAIP, "CDP_FEE") });
    const unused = new FakeFacilitator({ supported: supported(SOLANA_DEVNET_CAIP, "PAYAI_FEE") });
    const pinned = new FallbackFacilitatorClient(healthy, unused, SOLANA_DEVNET_CAIP);
    const chosen = await pinned.getSupported();
    expect(pinned.active).toBe("cdp");
    expect(unused.supportedCalls).toBe(1);
    expect(chosen.kinds[0]?.extra).toMatchObject({ feePayer: "CDP_FEE" });
  });

  it("routes verify and settle to the facilitator that owns extra.feePayer", async () => {
    const primary = new FakeFacilitator({
      supported: supported(SOLANA_DEVNET_CAIP, "CDP_FEE"),
      verify: httpError(500),
      settle: httpError(500),
    });
    const payai = new FakeFacilitator({ supported: supported(SOLANA_DEVNET_CAIP, "PAYAI_FEE") });
    let refreshes = 0;
    const client = new FallbackFacilitatorClient(primary, payai, SOLANA_DEVNET_CAIP, undefined, async () => {
      refreshes += 1;
    });
    await client.getSupported();
    await expect(client.verify(payload, priced("CDP_FEE"))).rejects.toThrow(/500/);
    expect(payai.verifyCalls).toBe(0);
    expect(client.active).toBe("payai");
    expect(refreshes).toBe(1);
    await expect(client.settle(payload, priced("CDP_FEE"))).rejects.toThrow(/500/);
    expect(payai.settleCalls).toBe(0);
    await expect(client.verify(payload, priced("PAYAI_FEE"))).resolves.toMatchObject({ isValid: true });
    expect(payai.verifyCalls).toBe(1);
    expect(primary.verifyCalls).toBe(1);
    const rebuilt = await client.getSupported();
    expect(rebuilt.kinds[0]?.extra).toMatchObject({ feePayer: "PAYAI_FEE" });
  });

  it("does not retry a settle that reached CDP, including a connect failure with that fee payer", async () => {
    const refused = new FakeFacilitator({
      supported: supported(SOLANA_DEVNET_CAIP, "CDP_FEE"),
      settle: connectError(),
    });
    const payai = new FakeFacilitator({ supported: supported(SOLANA_DEVNET_CAIP, "PAYAI_FEE") });
    const client = new FallbackFacilitatorClient(refused, payai, SOLANA_DEVNET_CAIP);
    await client.getSupported();
    await expect(client.settle(payload, priced("CDP_FEE"))).rejects.toThrow(/fetch failed/);
    expect(payai.settleCalls).toBe(0);
    expect(client.active).toBe("payai");

    const timeout = new Error("settle timed out");
    timeout.name = "FacilitatorTimeoutError";
    const slow = new FakeFacilitator({ settle: timeout, supported: supported(SOLANA_DEVNET_CAIP, "CDP_FEE") });
    const other = new FakeFacilitator({ supported: supported(SOLANA_DEVNET_CAIP, "PAYAI_FEE") });
    const stuck = new FallbackFacilitatorClient(slow, other, SOLANA_DEVNET_CAIP);
    await stuck.getSupported();
    await expect(stuck.settle(payload, priced("CDP_FEE"))).rejects.toThrow(/timed out/);
    expect(other.settleCalls).toBe(0);
    expect(stuck.active).toBe("cdp");
  });

  it("restores CDP on the next probe and does not postpone that probe when calls keep failing", async () => {
    const primary = new FakeFacilitator({
      supported: supported(SOLANA_DEVNET_CAIP, "CDP_FEE"),
      verify: httpError(500),
    });
    const payai = new FakeFacilitator({ supported: supported(SOLANA_DEVNET_CAIP, "PAYAI_FEE") });
    let refreshes = 0;
    const client = new FallbackFacilitatorClient(primary, payai, SOLANA_DEVNET_CAIP, undefined, async () => {
      refreshes += 1;
    });
    await client.getSupported();
    const supportedBefore = primary.supportedCalls;
    await expect(client.verify(payload, priced("CDP_FEE"))).rejects.toThrow(/500/);
    expect(client.health()).toMatchObject({ active: "payai", cdp: "down" });
    const due = client.nextCdpProbeAt ?? 0;
    expect(due).toBeGreaterThan(Date.now());
    await expect(client.verify(payload, priced("CDP_FEE"))).rejects.toThrow(/500/);
    expect(client.nextCdpProbeAt).toBe(due);
    expect(await client.probeRecovery(due - 1)).toBe("skipped");
    expect(primary.supportedCalls).toBe(supportedBefore);

    primary.behavior.supported = httpError(503);
    expect(await client.probeRecovery(due)).toBe("still_down");
    expect(client.active).toBe("payai");
    expect(client.nextCdpProbeAt).toBe(due + CDP_RECOVERY_INTERVAL_MS);

    primary.behavior.supported = supported(SOLANA_DEVNET_CAIP, "CDP_FEE");
    expect(await client.probeRecovery(due + CDP_RECOVERY_INTERVAL_MS)).toBe("restored");
    expect(client.health()).toMatchObject({ active: "cdp", cdp: "primary", cdpNextProbeAt: null });
    expect(refreshes).toBe(2);
    const rebuilt = await client.getSupported();
    expect(rebuilt.kinds[0]?.extra).toMatchObject({ feePayer: "CDP_FEE" });
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
