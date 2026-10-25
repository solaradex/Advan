/**
 * Pay for token_risk and wallet_portfolio over x402 with devnet USDC.
 * The server must already be running with X402_NETWORK set to Solana devnet
 * and X402_PAY_TO set to a wallet that already has a devnet USDC token account.
 * The server embeds the payment blockhash from X402_RPC_URL (devnet when unset),
 * never from SOLANA_RPC_URL.
 *
 *   SOLANA_KEYPAIR_PATH=./devnet-payer.json \
 *   X402_CLIENT_RPC_URL=https://api.devnet.solana.com \
 *   ADVAN_HTTP_URL=http://127.0.0.1:8787 \
 *   npm run e2e:devnet
 *
 * SOLANA_KEYPAIR_PATH is read only here. The Advan server ignores it.
 * X402_CLIENT_RPC_URL is the buyer's RPC. Public devnet RPC is often unreachable;
 * point this at a devnet endpoint you can use.
 */
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { SOLANA_DEVNET_CAIP, USDC_MAINNET_MINT } from "../src/constants.js";

const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
const baseUrl = process.env.ADVAN_HTTP_URL || "http://127.0.0.1:8787";
const network = process.env.X402_NETWORK || SOLANA_DEVNET_CAIP;
const rpcUrl = process.env.X402_CLIENT_RPC_URL || "https://api.devnet.solana.com";
if (!keypairPath) {
  process.stderr.write("Set SOLANA_KEYPAIR_PATH to a Solana CLI JSON keypair funded with devnet USDC.\n");
  process.exit(1);
}

const secret = new Uint8Array(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]);
const signer = await createKeyPairSignerFromBytes(secret);
const client = new x402Client().register(
  network as `${string}:${string}`,
  new ExactSvmScheme(signer, { rpcUrl }),
);
const payFetch = wrapFetchWithPayment(fetch, client);
const mint = process.env.E2E_MINT || USDC_MAINNET_MINT;
const owner = signer.address;

const risk = await pay(`${baseUrl}/v1/token_risk`, { mint });
const portfolio = await pay(`${baseUrl}/v1/wallet_portfolio`, { owner });
process.stdout.write(`${JSON.stringify({ rpcUrl, risk, portfolio }, null, 2)}\n`);
if (!risk.ok || !portfolio.ok) process.exit(1);

async function pay(url: string, body: unknown): Promise<{ ok: boolean; status: number; payment: unknown; body: unknown }> {
  const response = await payFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const paymentHeader = response.headers.get("PAYMENT-RESPONSE");
  return {
    ok: response.ok,
    status: response.status,
    payment: paymentHeader ? decodePaymentResponseHeader(paymentHeader) : null,
    body: safeJson(text),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
