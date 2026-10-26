/**
 * Build UNSIGNED claim transactions for accrued Jupiter referral fees.
 * The partner/payer signs them locally. This script never reads a keypair.
 *
 *   REFERRAL_PAYER_PUBKEY=<pubkey> JUPITER_REFERRAL_ACCOUNT=<account> npm run claim:referral
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { ReferralProvider } from "@jup-ag/referral-sdk";

const payerRaw = process.env.REFERRAL_PAYER_PUBKEY;
const referralRaw = process.env.JUPITER_REFERRAL_ACCOUNT;
if (!payerRaw || !referralRaw) {
  process.stderr.write("Set REFERRAL_PAYER_PUBKEY and JUPITER_REFERRAL_ACCOUNT. No keypair is read.\n");
  process.exit(1);
}

const payer = new PublicKey(payerRaw);
const referral = new PublicKey(referralRaw);
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const provider = new ReferralProvider(connection);
const txs = await provider.claimAllV2({ payerPubKey: payer, referralAccountPubKey: referral });
const transactions = txs.map((tx, index) => ({
  index,
  base64: Buffer.from(tx.serialize()).toString("base64"),
}));

process.stdout.write(
  `${JSON.stringify(
    {
      warning: "Unsigned claim transactions. Sign them in the partner wallet. Advan does not sign.",
      payer: payer.toBase58(),
      referralAccount: referral.toBase58(),
      count: transactions.length,
      transactions,
    },
    null,
    2,
  )}\n`,
);
