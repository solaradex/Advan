import { afterEach, describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { SOLANA_DEVNET_CAIP, USDC_MAINNET_MINT } from "../src/constants.js";
import { withFreshPayment } from "../src/mcp/server.js";
import { lookupTableAddresses, referralAccountInTransaction, type InspectedTransaction } from "../src/solana/unsignedTx.js";
import { REFERRAL_TOKEN_ACCOUNT } from "./helpers.js";

const PAY_TO = "11111111111111111111111111111111";
const base58 = getBase58Decoder();
const base58Encode = getBase58Encoder();
const BLOCK_A = base58.decode(new Uint8Array(32).fill(7));
const BLOCK_B = base58.decode(new Uint8Array(32).fill(8));
const BLOCK_TTL_MS = 90_000;

class RecordingFacilitator implements FacilitatorClient {
  verified: string[] = [];
  settled: string[] = [];
  private readonly issued = new Map<string, number>();

  note(blockhash: string, at: number): void {
    this.issued.set(blockhash, at);
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP,
          extra: { feePayer: "PAYAI_FEE" },
        },
      ],
      extensions: [],
      signers: {},
    };
  }

  async verify(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const blockhash = String(requirements.extra?.recentBlockhash ?? "");
    this.verified.push(blockhash);
    const at = this.issued.get(blockhash);
    if (at == null || Date.now() - at > BLOCK_TTL_MS) {
      return { isValid: false, invalidReason: "invalid_exact_svm_transaction_simulation_failed" };
    }
    return { isValid: true, payer: PAY_TO };
  }

  async settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settled.push(String(requirements.extra?.recentBlockhash ?? ""));
    return { success: true, transaction: "sig", network: SOLANA_DEVNET_CAIP, payer: PAY_TO };
  }
}

describe("fresh MCP payment requirements", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles a paid call after a simulated two-minute wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-25T00:00:00.000Z");
    vi.setSystemTime(start);
    const facilitator = new RecordingFacilitator();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : "";
        if (!body.includes("getLatestBlockhash")) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
        }
        const blockhash = Date.now() - start.getTime() >= 120_000 ? BLOCK_B : BLOCK_A;
        facilitator.note(blockhash, Date.now());
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 100 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const resourceServer = new x402ResourceServer(facilitator).register(
      SOLANA_DEVNET_CAIP,
      new ExactSvmScheme({ rpcUrl: "https://api.devnet.solana.com" }),
    );
    await resourceServer.initialize();
    const x402 = {
      resourceServer,
      buildAccepts: () =>
        resourceServer.buildPaymentRequirements({
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP,
          payTo: PAY_TO,
          price: "$0.01",
        }),
    };
    const handler = withFreshPayment(x402, "token risk", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    const unpaid = await handler({ mint: USDC_MAINNET_MINT });
    const required = unpaid.structuredContent as { accepts?: PaymentRequirements[] } | undefined;
    const first = required?.accepts?.[0];
    expect(first?.extra?.recentBlockhash).toBe(BLOCK_A);

    vi.advanceTimersByTime(120_000);
    const paid = await handler(
      { mint: USDC_MAINNET_MINT },
      {
        _meta: {
          "x402/payment": {
            x402Version: 2,
            accepted: first,
            payload: { transaction: "dGVzdA==" },
          },
        },
      },
    );
    expect(paid.isError).not.toBe(true);
    expect(facilitator.verified).toEqual([BLOCK_B]);
    expect(facilitator.settled).toEqual([BLOCK_B]);
  });
});

describe("referral account in a transaction", () => {
  it("finds the account in a loaded address lookup table and rejects a swapped index", async () => {
    const table = "SysvarC1ock11111111111111111111111111111111";
    const other = base58.decode(new Uint8Array(32).fill(9));
    const data = Buffer.alloc(56 + 64);
    data.set(base58Encode.encode(REFERRAL_TOKEN_ACCOUNT), 56);
    data.set(base58Encode.encode(other), 88);
    const inspected: InspectedTransaction = {
      feePayer: PAY_TO,
      signers: [PAY_TO],
      staticAccounts: [PAY_TO],
      lookups: [{ lookupTableAddress: table, writableIndexes: [0], readonlyIndexes: [] }],
      allZeroSignatures: true,
      version: "0",
    };
    const rpc = {
      async getAccountData() {
        return data;
      },
    };
    expect(await referralAccountInTransaction(inspected, REFERRAL_TOKEN_ACCOUNT, rpc)).toBe("present");
    const swapped: InspectedTransaction = {
      ...inspected,
      lookups: [{ lookupTableAddress: table, writableIndexes: [1], readonlyIndexes: [] }],
    };
    expect(await referralAccountInTransaction(swapped, REFERRAL_TOKEN_ACCOUNT, rpc)).toBe("absent");
    expect(lookupTableAddresses(data)[0]).toBe(REFERRAL_TOKEN_ACCOUNT);
  });
});
