/** Wrapped SOL. Same mint on mainnet and devnet. Fees labeled "SOL" settle here. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Mainnet USDC. Jupiter referral fees in USDC use this mint, not the devnet faucet mint. */
export const USDC_MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const USDT_MAINNET_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Circle devnet USDC used by x402 exact payments. */
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Associated Token Account program. V2 referral token accounts are ATAs of the referral account. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Jupiter Ultra / Swap referral project. From the referral program docs. */
export const JUPITER_REFERRAL_PROJECT = "DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc";

/** Referral program. Legacy token accounts are PDAs of this program; V2 accounts are ATAs. */
export const JUPITER_REFERRAL_PROGRAM = "REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3";

export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

/** Default USD notional cap when MAX_TRADE_USD is unset. `off` disables it. */
export const DEFAULT_MAX_TRADE_USD = 1000;

export const SOLANA_MAINNET_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET_CAIP = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/**
 * USDC mint the e2e payer should use for a network string.
 * Devnet (including the script's default CAIP id) uses Circle's faucet mint.
 */
export function usdcMintForNetwork(network: string): string {
  if (network === "devnet" || network === "solana-devnet" || network === SOLANA_DEVNET_CAIP) return USDC_DEVNET_MINT;
  return USDC_MAINNET_MINT;
}

export const REFERRAL_FEE_MIN_BPS = 50;
export const REFERRAL_FEE_MAX_BPS = 255;
export const DEFAULT_REFERRAL_FEE_BPS = 50;

/** Jupiter keeps 20% of the referral fee. 50 bps charged => 40 bps to the partner. */
export const JUPITER_REFERRAL_CUT_BPS = 2000;

export const DEFAULT_X402_PRICE_USD = 0.01;
export const CDP_SETTLEMENT_FEE_USD = 0.001;
/** PayAI Solana mainnet `exact`, live rate effective 2026-10-15. Devnet settlements are free. */
export const PAYAI_MAINNET_EXACT_FEE_USD = 0.00133;
export const PAYAI_DEVNET_EXACT_FEE_USD = 0;
export const DEFAULT_FEE_MULTIPLE = 5;

export const JUPITER_EXECUTE_URL = "https://api.jup.ag/swap/v2/execute";

export const RISKY_TOKEN_2022_EXTENSIONS = [
  "transferFeeConfig",
  "permanentDelegate",
  "transferHook",
  "nonTransferable",
  "defaultAccountState",
] as const;

export const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
