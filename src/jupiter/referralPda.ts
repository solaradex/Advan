import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { JUPITER_REFERRAL_PROGRAM } from "../constants.js";

const encoder = getAddressEncoder();

/**
 * Referral token account PDA. Seeds match `@jup-ag/referral-sdk`
 * `getReferralTokenAccountPubKey`: `"referral_ata"`, referral account, mint.
 * Program: `REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3`.
 */
export async function referralTokenAccountAddress(referralAccount: string, mint: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(JUPITER_REFERRAL_PROGRAM),
    seeds: [
      new TextEncoder().encode("referral_ata"),
      encoder.encode(address(referralAccount)),
      encoder.encode(address(mint)),
    ],
  });
  return pda;
}
