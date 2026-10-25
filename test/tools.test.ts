import { describe, expect, it } from "vitest";
import { WSOL_MINT, USDC_MAINNET_MINT } from "../src/constants.js";
import { FeeCheckError, GuardError } from "../src/errors.js";
import { MemoryUsageLogger } from "../src/log.js";
import { encodeUnsignedTransaction } from "../src/solana/unsignedTx.js";
import { buildSwapTx } from "../src/tools/buildSwap.js";
import { getQuote } from "../src/tools/getQuote.js";
import { walletPortfolio } from "../src/tools/portfolio.js";
import { FakeJupiter, orderResponse, REFERRAL, REFERRAL_TOKEN_ACCOUNT, testConfig, toolContext } from "./helpers.js";

const unsigned = encodeUnsignedTransaction({ signers: [REFERRAL], writable: [REFERRAL_TOKEN_ACCOUNT] });
const marketMaker = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const jupiterzTx = encodeUnsignedTransaction({
  signers: [REFERRAL, marketMaker],
  writable: [REFERRAL_TOKEN_ACCOUNT],
});

const quoteInput = {
  inputMint: WSOL_MINT,
  outputMint: USDC_MAINNET_MINT,
  amount: "100000000",
};

describe("swap tools", () => {
  it("does not call Jupiter when the requested slippage exceeds the guard", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    const ctx = toolContext(testConfig(), jupiter);
    await expect(getQuote({ ...quoteInput, slippageBps: 900 }, ctx)).rejects.toBeInstanceOf(GuardError);
    expect(jupiter.calls).toHaveLength(0);
  });

  it("refuses an oversized USD trade before requesting an order", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    const ctx = toolContext(testConfig({ MAX_TRADE_USD: "1" }), jupiter);
    await expect(getQuote(quoteInput, ctx)).rejects.toThrow(/maxTradeUsd/);
    expect(jupiter.calls).toHaveLength(0);
  });

  it("refuses the trade when a USD cap is set and the price is missing", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    jupiter.price = undefined;
    const ctx = toolContext(testConfig({ MAX_TRADE_USD: "10" }), jupiter);
    await expect(getQuote(quoteInput, ctx)).rejects.toThrow(/price is unavailable/);
    expect(jupiter.calls).toHaveLength(0);
  });

  it("attaches the referral fee and returns a quote when the assertion passes", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    const log = new MemoryUsageLogger();
    const ctx = toolContext(testConfig(), jupiter, log);
    const quote = await getQuote({ ...quoteInput, slippageBps: 50 }, ctx);
    expect(jupiter.calls[0]).toMatchObject({ referralAccount: REFERRAL, referralFee: 50, slippageBps: 50 });
    expect(jupiter.calls[0]?.taker).toBeUndefined();
    expect(quote.transaction).toBeNull();
    expect(quote.feeCheck.ok).toBe(true);
    expect(log.events[0]?.kind).toBe("tool");
    expect(log.events[0]?.feeBps).toBe(50);
  });

  it("fails closed on a fee-check miss and can warn instead", async () => {
    const dropped = orderResponse({ feeBps: 2, referralAccount: null, transaction: unsigned });
    const jupiter = new FakeJupiter(dropped);
    const log = new MemoryUsageLogger();
    await expect(buildSwapTx({ ...quoteInput, taker: REFERRAL }, toolContext(testConfig(), jupiter, log))).rejects.toBeInstanceOf(
      FeeCheckError,
    );
    expect(log.events[0]?.kind).toBe("fee_check_failure");
    expect(log.events[0]?.success).toBe(false);

    const warnLog = new MemoryUsageLogger();
    const warned = await buildSwapTx(
      { ...quoteInput, taker: REFERRAL },
      toolContext(testConfig({ FEE_CHECK_MODE: "warn" }), new FakeJupiter(dropped), warnLog),
    );
    expect(warned.transaction).toBe(unsigned);
    expect(warned.feeCheck.ok).toBe(false);
    expect(warnLog.events[0]?.kind).toBe("fee_check_failure");
    expect(warnLog.events[0]?.success).toBe(true);
  });

  it("excludes jupiterz for self-broadcast and rejects a foreign fee payer", async () => {
    const jupiter = new FakeJupiter(orderResponse({ transaction: unsigned, signatureFeePayer: REFERRAL }));
    const ctx = toolContext(testConfig(), jupiter);
    const built = await buildSwapTx({ ...quoteInput, taker: REFERRAL, selfBroadcast: true }, ctx);
    expect(jupiter.calls[0]?.excludeRouters).toBe("jupiterz");
    expect(built.submit.method).toBe("self");
    expect(built.signing.status).toBe("unsigned");
    expect(built.signing.feePayer).toBe(REFERRAL);
    expect(built.signing.signers).toEqual([REFERRAL]);

    const foreign = new FakeJupiter(
      orderResponse({ transaction: unsigned, signatureFeePayer: USDC_MAINNET_MINT, router: "metis" }),
    );
    await expect(
      buildSwapTx({ ...quoteInput, taker: REFERRAL, selfBroadcast: true }, toolContext(testConfig(), foreign)),
    ).rejects.toThrow(/signatureFeePayer/);

    const rfq = new FakeJupiter(orderResponse({ transaction: jupiterzTx, router: "jupiterz", swapType: "rfq" }));
    const managed = await buildSwapTx({ ...quoteInput, taker: REFERRAL }, toolContext(testConfig(), rfq));
    expect(rfq.calls[0]?.excludeRouters).toBeUndefined();
    expect(managed.submit.method).toBe("jupiter");
    expect(managed.submit.coSignRequired).toBe(true);
    expect(managed.signing.signers).toEqual([REFERRAL, marketMaker]);
  });

  it("re-quotes without a referral when the fee mint has no token account", async () => {
    const bad = orderResponse({
      feeBps: 2,
      referralAccount: null,
      feeMint: USDC_MAINNET_MINT,
      inputMint: WSOL_MINT,
    });
    const good = orderResponse({ feeBps: 2, referralAccount: null, transaction: null });
    const jupiter = new FakeJupiter(good);
    jupiter.queue = [bad, good];
    const log = new MemoryUsageLogger();
    const quote = await getQuote(quoteInput, toolContext(testConfig(), jupiter, log));
    expect(jupiter.calls).toHaveLength(2);
    expect(jupiter.calls[0]?.referralAccount).toBe(REFERRAL);
    expect(jupiter.calls[1]?.referralAccount).toBeUndefined();
    expect(quote.feeCheck.omittedReferral).toBe(true);
    expect(quote.feeCheck.ok).toBe(true);
    expect(log.events.some((event) => event.kind === "referral_requote")).toBe(true);
  });

  it("does not re-quote when the configured account is the wrong PDA", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    const swapped = testConfig({ JUPITER_REFERRAL_TOKEN_ACCOUNT_SOL: USDC_MAINNET_MINT });
    await expect(getQuote(quoteInput, toolContext(swapped, jupiter))).rejects.toBeInstanceOf(FeeCheckError);
    expect(jupiter.calls).toHaveLength(1);
  });

  it("rejects a signed transaction and one that omits the referral account", async () => {
    const signed = Buffer.from(unsigned, "base64");
    signed[1] = 1;
    const jupiter = new FakeJupiter(orderResponse({ transaction: signed.toString("base64") }));
    await expect(buildSwapTx({ ...quoteInput, taker: REFERRAL }, toolContext(testConfig(), jupiter))).rejects.toThrow(/not unsigned/);

    const missing = encodeUnsignedTransaction({ signers: [REFERRAL] });
    const omitted = new FakeJupiter(orderResponse({ transaction: missing }));
    await expect(buildSwapTx({ ...quoteInput, taker: REFERRAL }, toolContext(testConfig(), omitted))).rejects.toThrow(
      /not in the transaction/,
    );
  });

  it("prices native SOL from wSOL on devnet", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    const ctx = toolContext(testConfig({ SOLANA_RPC_URL: "https://api.devnet.solana.com", MAX_TRADE_USD: "off" }), jupiter);
    const portfolio = await walletPortfolio({ owner: REFERRAL }, ctx);
    expect(ctx.config.dataCluster).toBe("devnet");
    expect(jupiter.priceCalls[0]).toEqual([WSOL_MINT]);
    expect(portfolio.sol.priceSource).toMatch(/devnet/);
    expect(portfolio.cluster).toBe("devnet");
  });

  it("rejects invalid tool input before calling Jupiter", async () => {
    const jupiter = new FakeJupiter(orderResponse());
    await expect(getQuote({ inputMint: "bad", outputMint: USDC_MAINNET_MINT, amount: "1" }, toolContext(testConfig(), jupiter))).rejects.toThrow(
      /inputMint/,
    );
    expect(jupiter.calls).toHaveLength(0);
  });
});
