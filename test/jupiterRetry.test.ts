import { describe, expect, it } from "vitest";
import { WSOL_MINT } from "../src/constants.js";
import { createJupiterClient } from "../src/jupiter/client.js";
import { UpstreamError } from "../src/errors.js";

describe("Jupiter 429 retry", () => {
  it("retries a price lookup with backoff and then returns the price", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ [WSOL_MINT]: { usdPrice: 150, decimals: 9 } }), { status: 200 });
    };
    const client = createJupiterClient({
      baseUrl: "https://api.jup.ag",
      timeoutMs: 1000,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const prices = await client.prices([WSOL_MINT]);
    expect(prices[WSOL_MINT]?.usdPrice).toBe(150);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it("does not retry a non-429 Jupiter error", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("no", { status: 400 });
    };
    const client = createJupiterClient({
      baseUrl: "https://api.jup.ag",
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    await expect(client.prices([WSOL_MINT])).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
  });
});
