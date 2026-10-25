/**
 * Pay for token_risk over x402 with devnet USDC.
 * The server must already be running with X402_NETWORK set to Solana devnet
 * and X402_PAY_TO set to a wallet that already has a devnet USDC token account.
 *
 *   SOLANA_KEYPAIR_PATH=./devnet-payer.json ADVAN_HTTP_URL=http://127.0.0.1:8787 npm run e2e:devnet
 *
 * SOLANA_KEYPAIR_PATH is read only here. The Advan server ignores it.
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
if (!keypairPath) {
  process.stderr.write("Set SOLANA_KEYPAIR_PATH to a Solana CLI JSON keypair funded with devnet USDC.\n");
  process.exit(1);
}

const secret = new Uint8Array(JSON.parse(readFileSync(keypairPath, "utf8")) as number[]);
const signer = await createKeyPairSignerFromBytes(secret);
const client = new x402Client().register(network as `${string}:${string}`, new ExactSvmScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);
const mint = process.env.E2E_MINT || USDC_MAINNET_MINT;

const response = await payFetch(`${baseUrl}/v1/token_risk`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ mint }),
});
const text = await response.text();
const paymentHeader = response.headers.get("PAYMENT-RESPONSE");
const payment = paymentHeader ? decodePaymentResponseHeader(paymentHeader) : null;
process.stdout.write(
  `${JSON.stringify({ status: response.status, payment, body: safeJson(text) }, null, 2)}\n`,
);
if (!response.ok) process.exit(1);

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
