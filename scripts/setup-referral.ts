/**
 * Build UNSIGNED transactions that create a Jupiter referral account and the
 * wSOL, USDC, and USDT referral token accounts. The payer signs them in their
 * own wallet. This script never reads a keypair.
 *
 *   REFERRAL_PAYER_PUBKEY=<pubkey> REFERRAL_NAME=advan npm run setup:referral
 *
 * Optional: REFERRAL_PARTNER_PUBKEY (defaults to the payer), SOLANA_RPC_URL,
 * REFERRAL_MINTS (comma-separated extra mints).
 */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { ReferralProvider } from "@jup-ag/referral-sdk";
import { JUPITER_REFERRAL_PROJECT, USDC_MAINNET_MINT, USDT_MAINNET_MINT, WSOL_MINT } from "../src/constants.js";

const payerRaw = process.env.REFERRAL_PAYER_PUBKEY;
const name = process.env.REFERRAL_NAME;
if (!payerRaw || !name) {
  process.stderr.write("Set REFERRAL_PAYER_PUBKEY and REFERRAL_NAME. No keypair is read or required.\n");
  process.exit(1);
}

const payer = new PublicKey(payerRaw);
const partner = new PublicKey(process.env.REFERRAL_PARTNER_PUBKEY || payerRaw);
const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const extra = (process.env.REFERRAL_MINTS || "")
  .split(",")
  .map((mint) => mint.trim())
  .filter((mint) => mint.length > 0);
const mints = [WSOL_MINT, USDC_MAINNET_MINT, USDT_MAINNET_MINT, ...extra];

const connection = new Connection(rpcUrl, "confirmed");
const provider = new ReferralProvider(connection);
const opened = await provider.initializeReferralAccountWithName({
  projectPubKey: new PublicKey(JUPITER_REFERRAL_PROJECT),
  partnerPubKey: partner,
  payerPubKey: payer,
  name,
});

const transactions: Array<Record<string, string>> = [
  {
    kind: "initializeReferralAccountWithName",
    referralAccount: opened.referralAccountPubKey.toBase58(),
    base64: await unsignedLegacy(connection, payer, opened.tx),
  },
];

for (const mint of mints) {
  const created = await provider.initializeReferralTokenAccountV2({
    payerPubKey: payer,
    referralAccountPubKey: opened.referralAccountPubKey,
    mint: new PublicKey(mint),
  });
  transactions.push({
    kind: "initializeReferralTokenAccountV2",
    mint,
    tokenAccount: created.tokenAccount.toBase58(),
    base64: await unsignedLegacy(connection, payer, created.tx),
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      warning: "Unsigned transactions. Sign and send them in order from your own wallet. Advan does not sign.",
      payer: payer.toBase58(),
      partner: partner.toBase58(),
      project: JUPITER_REFERRAL_PROJECT,
      name,
      referralAccount: opened.referralAccountPubKey.toBase58(),
      transactions,
    },
    null,
    2,
  )}\n`,
);

async function unsignedLegacy(connection: Connection, payer: PublicKey, tx: Transaction): Promise<string> {
  tx.feePayer = payer;
  const latest = await connection.getLatestBlockhash();
  tx.recentBlockhash = latest.blockhash;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
