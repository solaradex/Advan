import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { USDC_MAINNET_MINT, WSOL_MINT } from "../src/constants.js";
import { InsufficientFundsError, UpstreamError } from "../src/errors.js";
import { createApp } from "../src/http/app.js";
import { createJupiterClient } from "../src/jupiter/client.js";
import { MemoryUsageLogger } from "../src/log.js";
import { summarizeUsage } from "../src/stats.js";
import { getQuote } from "../src/tools/getQuote.js";
import { FakeJupiter, orderResponse, testConfig, toolContext } from "./helpers.js";

const orderParams = {
  inputMint: WSOL_MINT,
  outputMint: USDC_MAINNET_MINT,
  amount: "1000000",
};

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

function clientFor(status: number, body: unknown) {
  return createJupiterClient({
    baseUrl: "https://api.jup.ag",
    timeoutMs: 1000,
    fetchImpl: async () => jsonResponse(status, body),
    sleep: async () => {
      throw new Error("should not sleep");
    },
  });
}

describe("Jupiter wallet errors", () => {
  it("maps insufficient funds and similar wallet failures to insufficient_funds", async () => {
    const cases: Array<{ status: number; body: unknown; message: RegExp }> = [
      { status: 400, body: { error: "Insufficient funds" }, message: /Insufficient funds/ },
      { status: 422, body: { error: "Insufficient balance" }, message: /Insufficient balance/ },
      { status: 400, body: { message: "not enough SOL" }, message: /not enough SOL/ },
      { status: 200, body: { error: "Insufficient lamports" }, message: /Insufficient lamports/ },
      {
        status: 200,
        body: {
          inAmount: "1000",
          outAmount: "1",
          errorMessage: "Token account not found",
        },
        message: /Token account not found/,
      },
      {
        status: 400,
        body: { error: "missing account", errorCode: "TOKEN_ACCOUNT_NOT_FOUND" },
        message: /missing account/,
      },
      {
        status: 400,
        body: { errorMessage: "Insufficient input amount" },
        message: /Insufficient input amount/,
      },
    ];

    for (const entry of cases) {
      const error = await clientFor(entry.status, entry.body).order(orderParams).then(
        () => {
          throw new Error(`expected ${JSON.stringify(entry.body)} to fail`);
        },
        (caught: unknown) => caught,
      );
      expect(error, JSON.stringify(entry.body)).toBeInstanceOf(InsufficientFundsError);
      const mapped = error as InsufficientFundsError;
      expect(mapped.code).toBe("insufficient_funds");
      expect(mapped.status).toBe(400);
      expect(mapped.message).toMatch(entry.message);
      expect(mapped.message.startsWith("Jupiter order failed:")).toBe(true);
    }
  });

  it("keeps unrelated Jupiter failures as upstream errors", async () => {
    const route = await clientFor(500, { error: "Route not found" }).order(orderParams).then(
      () => {
        throw new Error("expected route failure");
      },
      (caught: unknown) => caught,
    );
    expect(route).toBeInstanceOf(UpstreamError);
    expect(route).not.toBeInstanceOf(InsufficientFundsError);
    expect((route as UpstreamError).code).toBe("upstream");
    expect((route as UpstreamError).status).toBe(502);

    const numericCode = await clientFor(400, { error: "bad request", code: 400 }).order(orderParams).then(
      () => {
        throw new Error("expected numeric code to stay upstream");
      },
      (caught: unknown) => caught,
    );
    expect(numericCode).toBeInstanceOf(UpstreamError);
    expect((numericCode as UpstreamError).code).toBe("upstream");

    const plain = await clientFor(400, "no").order(orderParams).then(
      () => {
        throw new Error("expected plain text to stay upstream");
      },
      (caught: unknown) => caught,
    );
    expect(plain).toBeInstanceOf(UpstreamError);
    expect((plain as UpstreamError).message).toBe("Jupiter HTTP 400");
  });

  it("returns HTTP 400 from get_quote and leaves /stats errors unchanged", async () => {
    const jupiter = clientFor(400, { error: "Insufficient funds", errorCode: "INSUFFICIENT_FUNDS" });
    const log = new MemoryUsageLogger();
    const ctx = toolContext(testConfig({ MAX_TRADE_USD: "off" }), jupiter, log);
    await expect(getQuote(orderParams, ctx)).rejects.toMatchObject({
      code: "insufficient_funds",
      status: 400,
    });
    expect(log.events[0]).toMatchObject({
      kind: "tool",
      tool: "get_quote",
      success: false,
      errorCode: "insufficient_funds",
    });
    const stats = summarizeUsage(log.events, new Date("2026-10-25T18:00:00.000Z"));
    expect(stats.errors).toBe(0);
    expect(stats.errorsByCode).toEqual({});
    expect(stats.clientErrors).toBe(1);
    expect(stats.clientErrorsByCode).toEqual({ insufficient_funds: 1 });
  });
});

describe("POST /v1/get_quote wallet errors", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const current = server;
    server = undefined;
    if (!current) return;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("responds 400 insufficient_funds instead of 502 upstream", async () => {
    const jupiter = clientFor(400, { error: "Insufficient funds" });
    const app = createApp({
      ctx: toolContext(testConfig({ MAX_TRADE_USD: "off" }), jupiter),
      x402: null,
    });
    const httpServer = createServer(app);
    server = httpServer;
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/get_quote`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(orderParams),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "insufficient_funds",
      error: expect.stringMatching(/Insufficient funds/),
    });

    const upstream = createApp({
      ctx: toolContext(testConfig({ MAX_TRADE_USD: "off" }), clientFor(500, { error: "Route not found" })),
      x402: null,
    });
    const upstreamServer = createServer(upstream);
    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("upstream test server has no port");
    try {
      const upstreamResponse = await fetch(`http://127.0.0.1:${upstreamAddress.port}/v1/get_quote`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(orderParams),
      });
      expect(upstreamResponse.status).toBe(502);
      expect(await upstreamResponse.json()).toMatchObject({ code: "upstream" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("quote guards stay client validation, not wallet errors", () => {
  it("still refuses an oversized trade before Jupiter", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    const ctx = toolContext(testConfig({ MAX_TRADE_USD: "1" }), jupiter);
    await expect(getQuote({ ...orderParams, amount: "100000000" }, ctx)).rejects.toMatchObject({
      code: "guard",
      status: 400,
    });
    expect(jupiter.calls).toHaveLength(0);
  });
});
