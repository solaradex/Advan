import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  JUPITER_REFERRAL_PROGRAM,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../constants.js";

const encoder = getAddressEncoder();

/**
 * V2 referral token account. This is the associated token account of the
 * referral account for `mint`, with `allowOwnerOffCurve` (referral accounts
 * are PDAs). The token program is the mint's owner: Token or Token-2022.
 * Matches `@jup-ag/referral-sdk` `getReferralTokenAccountPubKeyV2` and
 * `initializeReferralTokenAccountV2`.
 */
export async function referralTokenAccountAddress(
  referralAccount: string,
  mint: string,
  tokenProgram: string = TOKEN_PROGRAM_ID,
): Promise<string> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ID),
    seeds: [
      encoder.encode(address(referralAccount)),
      encoder.encode(address(tokenProgram)),
      encoder.encode(address(mint)),
    ],
  });
  return ata;
}

/**
 * Legacy referral token account from `initializeReferralTokenAccount`.
 * Seeds are `"referral_ata"`, the referral account, and the mint.
 */
export async function legacyReferralTokenAccountAddress(referralAccount: string, mint: string): Promise<string> {
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

export type ResolvedReferralAccount =
  | { ok: true; kind: "v2" | "legacy"; tokenProgram: string; v2Address: string }
  | { ok: false; message: string };

/**
 * Accept the V2 ATA. Accept the legacy PDA only when `legacyExists` is true.
 * Any other account, including another mint's ATA, is refused.
 */
export async function resolveConfiguredReferralAccount(input: {
  referralAccount: string;
  mint: string;
  configured: string;
  /** Mint owner. When omitted, either Token or Token-2022 ATA is accepted. */
  tokenProgram?: string;
  legacyExists: boolean | "unknown";
}): Promise<ResolvedReferralAccount> {
  const programs = input.tokenProgram ? [input.tokenProgram] : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const v2ByProgram = new Map<string, string>();
  for (const program of programs) {
    v2ByProgram.set(program, await referralTokenAccountAddress(input.referralAccount, input.mint, program));
  }
  for (const [program, v2] of v2ByProgram) {
    if (input.configured === v2) return { ok: true, kind: "v2", tokenProgram: program, v2Address: v2 };
  }
  const legacy = await legacyReferralTokenAccountAddress(input.referralAccount, input.mint);
  const expectedText = [...v2ByProgram.values()].join(" or ");
  if (input.configured === legacy) {
    if (input.legacyExists === true) {
      return {
        ok: true,
        kind: "legacy",
        tokenProgram: input.tokenProgram ?? TOKEN_PROGRAM_ID,
        v2Address: [...v2ByProgram.values()][0] ?? legacy,
      };
    }
    if (input.legacyExists === "unknown") {
      return {
        ok: false,
        message: `referral token account ${input.configured} for ${input.mint} is the legacy PDA and could not be confirmed on-chain. The V2 associated token account is ${expectedText}.`,
      };
    }
    return {
      ok: false,
      message: `referral token account ${input.configured} for ${input.mint} is the legacy PDA and does not exist. The V2 associated token account is ${expectedText}.`,
    };
  }
  return {
    ok: false,
    message: `referral token account ${input.configured} for ${input.mint} does not match the V2 associated token account ${expectedText}. A swapped account is refused.`,
  };
}
