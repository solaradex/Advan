import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from "../src/constants.js";
import {
  legacyReferralTokenAccountAddress,
  referralTokenAccountAddress,
  resolveConfiguredReferralAccount,
} from "../src/jupiter/referralPda.js";

/** Public Jupiter referral account. Its wSOL V2 ATA was read from mainnet. */
const JUPITER_REFERRAL = "18LeLp3B8yGctKtWKAXXqdB6Lf1GxmEa2fRL5xxa1ta";
const WSOL_V2_ATA = "HJTzBKGDuGKxscp9fRkSnrEELnxMFvu4jEFzEmsZHcXx";

describe("referral token account addresses", () => {
  it("derives the V2 ATA Jupiter uses for the published referral account and wSOL", async () => {
    const v2 = await referralTokenAccountAddress(JUPITER_REFERRAL, WSOL_MINT, TOKEN_PROGRAM_ID);
    const legacy = await legacyReferralTokenAccountAddress(JUPITER_REFERRAL, WSOL_MINT);
    const token2022 = await referralTokenAccountAddress(JUPITER_REFERRAL, WSOL_MINT, TOKEN_2022_PROGRAM_ID);
    expect(v2).toBe(WSOL_V2_ATA);
    expect(legacy).not.toBe(v2);
    expect(token2022).not.toBe(v2);
  });

  it("accepts that V2 account and refuses a swapped mint or a missing legacy PDA", async () => {
    const v2 = await resolveConfiguredReferralAccount({
      referralAccount: JUPITER_REFERRAL,
      mint: WSOL_MINT,
      configured: WSOL_V2_ATA,
      tokenProgram: TOKEN_PROGRAM_ID,
      legacyExists: false,
    });
    expect(v2).toMatchObject({ ok: true, kind: "v2", tokenProgram: TOKEN_PROGRAM_ID });

    const swapped = await referralTokenAccountAddress(JUPITER_REFERRAL, TOKEN_PROGRAM_ID);
    const wrong = await resolveConfiguredReferralAccount({
      referralAccount: JUPITER_REFERRAL,
      mint: WSOL_MINT,
      configured: swapped,
      tokenProgram: TOKEN_PROGRAM_ID,
      legacyExists: false,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.message).toMatch(/does not match the V2 associated token account/);

    const legacy = await legacyReferralTokenAccountAddress(JUPITER_REFERRAL, WSOL_MINT);
    const missing = await resolveConfiguredReferralAccount({
      referralAccount: JUPITER_REFERRAL,
      mint: WSOL_MINT,
      configured: legacy,
      tokenProgram: TOKEN_PROGRAM_ID,
      legacyExists: false,
    });
    expect(missing.ok).toBe(false);
    const present = await resolveConfiguredReferralAccount({
      referralAccount: JUPITER_REFERRAL,
      mint: WSOL_MINT,
      configured: legacy,
      tokenProgram: TOKEN_PROGRAM_ID,
      legacyExists: true,
    });
    expect(present).toMatchObject({ ok: true, kind: "legacy", v2Address: WSOL_V2_ATA });
  });
});
