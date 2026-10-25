/**
 * Build an UNSIGNED transaction that creates the recipient USDC associated
 * token account required before x402 can pay X402_PAY_TO. Does not sign.
 *
 *   X402_PAY_TO=<owner> REFERRAL_PAYER_PUBKEY=<fee payer> npm run setup:payto-ata
 *
 * X402_NETWORK selects devnet or mainnet USDC. Defaults to devnet.
 */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SOLANA_DEVNET_CAIP, SOLANA_MAINNET_CAIP, USDC_DEVNET_MINT, USDC_MAINNET_MINT } from "../src/constants.js";

const ownerRaw = process.env.X402_PAY_TO;
const payerRaw = process.env.REFERRAL_PAYER_PUBKEY || process.env.X402_PAY_TO;
if (!ownerRaw || !payerRaw) {
  process.stderr.write("Set X402_PAY_TO and REFERRAL_PAYER_PUBKEY. No keypair is read.\n");
  process.exit(1);
}

const network = process.env.X402_NETWORK || SOLANA_DEVNET_CAIP;
const mainnet = network === "mainnet" || network === SOLANA_MAINNET_CAIP || network === "solana";
const mint = new PublicKey(mainnet ? USDC_MAINNET_MINT : USDC_DEVNET_MINT);
const rpc =
  process.env.X402_RPC_URL || (mainnet ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const owner = new PublicKey(ownerRaw);
const payer = new PublicKey(payerRaw);
const ata = getAssociatedTokenAddressSync(mint, owner);
const connection = new Connection(rpc, "confirmed");
const existing = await connection.getAccountInfo(ata);
if (existing) {
  process.stdout.write(`${JSON.stringify({ exists: true, ata: ata.toBase58(), mint: mint.toBase58() }, null, 2)}\n`);
  process.exit(0);
}

const tx = new Transaction().add(createAssociatedTokenAccountInstruction(payer, ata, owner, mint));
tx.feePayer = payer;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
process.stdout.write(
  `${JSON.stringify(
    {
      warning: "Unsigned ATA creation. Sign it in the payer wallet. The facilitator will not create this account.",
      exists: false,
      ata: ata.toBase58(),
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      payer: payer.toBase58(),
      base64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    },
    null,
    2,
  )}\n`,
);
