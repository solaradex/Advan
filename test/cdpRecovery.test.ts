import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { paymentMiddleware } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { SOLANA_DEVNET_CAIP } from "../src/constants.js";
import { FallbackFacilitatorClient } from "../src/x402/fallbackFacilitator.js";
import { MemoryUsageLogger, nowIso } from "../src/log.js";

const PAY_TO = "11111111111111111111111111111111";
const NETWORK = SOLANA_DEVNET_CAIP as `${string}:${string}`;

class SwitchingFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  supportedCalls = 0;
  failNextVerify = false;

  constructor(private readonly feePayer: string) {}

  async getSupported(): Promise<SupportedResponse> {
    this.supportedCalls += 1;
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET_CAIP as Network, extra: { feePayer: this.feePayer } }],
      extensions: [],
      signers: {},
    };
  }

  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    if (this.failNextVerify) {
      this.failNextVerify = false;
      throw new Error("Facilitator request failed (500): down");
    }
    return { isValid: true, payer: PAY_TO };
  }

  async settle(): Promise<SettleResponse> {
    return { success: true, transaction: "sig", network: SOLANA_DEVNET_CAIP, payer: PAY_TO };
  }
}

function payloadFor(requirements: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid", description: "paid", mimeType: "application/json" },
    accepted: requirements,
    payload: {},
  } as PaymentPayload;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe("CDP recovery with the real resource server", () => {
  it("serves a paid request after failover and recovery", async () => {
    const cdp = new SwitchingFacilitator("CDP_FEE");
    const payai = new SwitchingFacilitator("PAYAI_FEE");
    const log = new MemoryUsageLogger();
    const serverRef: { current?: x402ResourceServer } = {};
    const facilitator = new FallbackFacilitatorClient(
      cdp,
      payai,
      SOLANA_DEVNET_CAIP,
      () => {
        log.write({
          ts: nowIso(),
          kind: "facilitator_failover",
          success: true,
          paymentStatus: "not_applicable",
          facilitator: "payai",
        });
      },
      async () => {
        if (!serverRef.current) throw new Error("resource server is not ready");
        await serverRef.current.initialize();
      },
      {
        onRecovered: () => {
          log.write({
            ts: nowIso(),
            kind: "facilitator_recovered",
            success: true,
            paymentStatus: "not_applicable",
            facilitator: "cdp",
          });
        },
      },
    );
    const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactSvmScheme());
    serverRef.current = resourceServer;
    await resourceServer.initialize();

    const app = express();
    app.use(express.json());
    app.use(
      paymentMiddleware(
        {
          "POST /paid": {
            accepts: { scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAY_TO },
            description: "paid read",
            mimeType: "application/json",
          },
        },
        resourceServer,
        undefined,
        undefined,
        false,
      ),
    );
    app.post("/paid", (_req, res) => res.json({ ok: true }));
    const http = await listen(app);
    try {
      const first = await post(http.url);
      expect(first.status).toBe(402);
      expect(feePayer(first.header)).toBe("CDP_FEE");

      cdp.failNextVerify = true;
      const requirements = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network: NETWORK,
        price: "$0.01",
        payTo: PAY_TO,
      });
      await expect(resourceServer.verifyPayment(payloadFor(requirements[0]!), requirements[0]!)).rejects.toThrow(/500/);
      expect(facilitator.active).toBe("payai");
      const duringFailover = await post(http.url);
      expect(duringFailover.status).toBe(402);
      expect(feePayer(duringFailover.header)).toBe("PAYAI_FEE");

      const recovered = await facilitator.probeRecovery(facilitator.nextCdpProbeAt);
      expect(recovered).toBe("restored");
      expect(facilitator.health().cdp).toBe("primary");
      const after = await post(http.url);
      expect(after.status).toBe(402);
      expect(feePayer(after.header)).toBe("CDP_FEE");

      const again = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network: NETWORK,
        price: "$0.01",
        payTo: PAY_TO,
      });
      const paid = await resourceServer.verifyPayment(payloadFor(again[0]!), again[0]!);
      expect(paid.isValid).toBe(true);
      expect(cdp.verifyCalls).toBe(2);
      expect(payai.verifyCalls).toBe(0);
      expect(log.events.some((event) => event.kind === "facilitator_recovered" && event.facilitator === "cdp")).toBe(true);
    } finally {
      await http.close();
    }
  });

  it("reloads PayAI when the CDP restore times out", async () => {
    const cdp = new SwitchingFacilitator("CDP_FEE");
    const payai = new SwitchingFacilitator("PAYAI_FEE");
    const serverRef: { current?: x402ResourceServer } = {};
    let refreshes = 0;
    const facilitator = new FallbackFacilitatorClient(
      cdp,
      payai,
      SOLANA_DEVNET_CAIP,
      undefined,
      async () => {
        refreshes += 1;
        if (refreshes === 2) await new Promise(() => undefined);
        if (!serverRef.current) throw new Error("resource server is not ready");
        await serverRef.current.initialize();
      },
      { refreshTimeoutMs: 30 },
    );
    const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactSvmScheme());
    serverRef.current = resourceServer;
    await resourceServer.initialize();
    cdp.failNextVerify = true;
    const requirements = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: NETWORK,
      price: "$0.01",
      payTo: PAY_TO,
    });
    await expect(resourceServer.verifyPayment(payloadFor(requirements[0]!), requirements[0]!)).rejects.toThrow(/500/);
    const outcome = await facilitator.probeRecovery(facilitator.nextCdpProbeAt);
    expect(outcome).toBe("still_down");
    expect(facilitator.health().cdp).toBe("down");
    const reloaded = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: NETWORK,
      price: "$0.01",
      payTo: PAY_TO,
    });
    expect(reloaded[0]?.extra?.feePayer).toBe("PAYAI_FEE");
  });
});

async function post(url: string): Promise<{ status: number; header: string }> {
  const response = await fetch(`${url}/paid`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  return { status: response.status, header: response.headers.get("payment-required") ?? "" };
}

function feePayer(header: string): unknown {
  return decodePaymentRequiredHeader(header).accepts[0]?.extra?.feePayer;
}
