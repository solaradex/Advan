import { USDC_MAINNET_MINT, USDT_MAINNET_MINT, WSOL_MINT, PUBKEY_RE } from "../constants.js";
import { ConfigError } from "../errors.js";

export interface ReferralTokenAccountInput {
  /** Account that receives fees when Jupiter picks wSOL. `JUPITER_REFERRAL_TOKEN_ACCOUNT_SOL`. */
  sol?: string;
  /** Same mint as `sol`. If both are set they must be equal. */
  wsol?: string;
  /** Account for mainnet USDC (`EPjFW…`). */
  usdc?: string;
  /** Account for mainnet USDT. */
  usdt?: string;
  /** JSON object of mint → referral token account for any other fee mint. */
  extraJson?: string;
}

export function selectReferralTokenAccount(
  feeMint: string | undefined,
  tokenAccounts: Record<string, string>,
): string | undefined {
  if (!feeMint) return undefined;
  return tokenAccounts[feeMint];
}

export function buildReferralTokenAccountMap(input: ReferralTokenAccountInput): Record<string, string> {
  const map: Record<string, string> = {};
  const sol = input.sol;
  const wsol = input.wsol;
  if (sol && wsol && sol !== wsol) {
    throw new ConfigError(
      "JUPITER_REFERRAL_TOKEN_ACCOUNT_SOL and JUPITER_REFERRAL_TOKEN_ACCOUNT_WSOL must be the same account",
    );
  }
  const solAccount = wsol ?? sol;
  if (solAccount) map[WSOL_MINT] = assertAccount(solAccount, "wSOL referral token account");
  if (input.usdc) map[USDC_MAINNET_MINT] = assertAccount(input.usdc, "USDC referral token account");
  if (input.usdt) map[USDT_MAINNET_MINT] = assertAccount(input.usdt, "USDT referral token account");
  if (input.extraJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.extraJson);
    } catch {
      throw new ConfigError("JUPITER_REFERRAL_TOKEN_ACCOUNTS must be a JSON object of mint to token account");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError("JUPITER_REFERRAL_TOKEN_ACCOUNTS must be a JSON object");
    }
    for (const [mint, account] of Object.entries(parsed)) {
      if (typeof account !== "string") {
        throw new ConfigError(`referral token account for ${mint} must be a string`);
      }
      map[assertAccount(mint, "referral fee mint")] = assertAccount(account, `referral token account for ${mint}`);
    }
  }
  return map;
}

function assertAccount(value: string, label: string): string {
  if (!PUBKEY_RE.test(value)) throw new ConfigError(`${label} is not a Solana address`);
  return value;
}
