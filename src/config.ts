import {
  CDP_SETTLEMENT_FEE_USD,
  DEFAULT_FEE_MULTIPLE,
  DEFAULT_REFERRAL_FEE_BPS,
  DEFAULT_X402_PRICE_USD,
  PAYAI_DEVNET_EXACT_FEE_USD,
  PAYAI_MAINNET_EXACT_FEE_USD,
  PUBKEY_RE,
  REFERRAL_FEE_MAX_BPS,
  REFERRAL_FEE_MIN_BPS,
  SOLANA_DEVNET_CAIP,
  SOLANA_MAINNET_CAIP,
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
  USDT_MAINNET_MINT,
  WSOL_MINT,
} from "./constants.js";
import { ConfigError } from "./errors.js";
import { buildReferralTokenAccountMap } from "./jupiter/referralAccounts.js";

export type FeeCheckMode = "fail" | "warn";
export type PriceGuardMode = "warn" | "refuse";
export type SolanaCluster = "mainnet" | "devnet";

export interface X402Config {
  payTo?: string;
  priceUsd: number;
  priceLabel: string;
  network: string;
  cluster: SolanaCluster;
  usdcMint: string;
  priceGuard: PriceGuardMode;
  minFeeMultiple: number;
  cdpFeeUsd: number;
  payaiFeeUsd: number;
  cdpConfigured: boolean;
  facilitatorTimeoutMs: number;
  required: boolean;
}

export interface ReferralConfig {
  account?: string;
  feeBps: number;
  tokenAccounts: Record<string, string>;
  required: boolean;
}

export interface AppConfig {
  host: string;
  port: number;
  allowedHosts: string[];
  solanaRpcUrl: string;
  rpcTimeoutMs: number;
  jupiterApiBase: string;
  jupiterApiKey?: string;
  jupiterTimeoutMs: number;
  rugcheckBaseUrl: string;
  rugcheckTimeoutMs: number;
  referral: ReferralConfig;
  feeCheckMode: FeeCheckMode;
  limits: {
    maxSlippageBps: number;
    maxTradeUsd?: number;
    maxInputAmount?: bigint;
    maxPriceImpactPct: number;
  };
  swapSelfBroadcastDefault: boolean;
  x402: X402Config;
  usageLogPath: string;
  usageLogStdout: boolean;
  warnings: string[];
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseBool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value == null) return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

function parsePubkey(value: string, name: string): string {
  if (!PUBKEY_RE.test(value)) throw new ConfigError(`${name} is not a Solana address`);
  return value;
}

function parseFeeBps(value: string | undefined): number {
  const raw = value ?? String(DEFAULT_REFERRAL_FEE_BPS);
  if (!/^\d+$/.test(raw)) throw new ConfigError("JUPITER_REFERRAL_FEE_BPS must be an integer");
  const feeBps = Number(raw);
  if (feeBps < REFERRAL_FEE_MIN_BPS || feeBps > REFERRAL_FEE_MAX_BPS) {
    throw new ConfigError(
      `JUPITER_REFERRAL_FEE_BPS must be from ${REFERRAL_FEE_MIN_BPS} to ${REFERRAL_FEE_MAX_BPS} (Jupiter referral program bounds)`,
    );
  }
  return feeBps;
}

function parsePriceUsd(value: string | undefined): number {
  const raw = value ?? String(DEFAULT_X402_PRICE_USD);
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0 || price > 100) {
    throw new ConfigError("X402_PRICE_USD must be a number greater than 0 and at most 100");
  }
  return price;
}

export function formatX402Price(usd: number): string {
  const fixed = usd.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `$${fixed}`;
}

function parseCluster(value: string | undefined): { network: string; cluster: SolanaCluster; usdcMint: string } {
  const raw = value ?? SOLANA_DEVNET_CAIP;
  if (raw === "devnet" || raw === SOLANA_DEVNET_CAIP || raw === "solana-devnet") {
    return { network: SOLANA_DEVNET_CAIP, cluster: "devnet", usdcMint: USDC_DEVNET_MINT };
  }
  if (raw === "mainnet" || raw === "mainnet-beta" || raw === SOLANA_MAINNET_CAIP || raw === "solana") {
    return { network: SOLANA_MAINNET_CAIP, cluster: "mainnet", usdcMint: USDC_MAINNET_MINT };
  }
  throw new ConfigError(
    `X402_NETWORK must be ${SOLANA_DEVNET_CAIP} (devnet) or ${SOLANA_MAINNET_CAIP} (mainnet)`,
  );
}

function parsePositive(value: string | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive number`);
  return parsed;
}

function parseIntInRange(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be an integer`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new ConfigError(`${name} must be from ${min} to ${max}`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const warnings: string[] = [];
  const feeBps = parseFeeBps(optional(env, "JUPITER_REFERRAL_FEE_BPS"));
  const referralAccountRaw = optional(env, "JUPITER_REFERRAL_ACCOUNT");
  const referralAccount = referralAccountRaw ? parsePubkey(referralAccountRaw, "JUPITER_REFERRAL_ACCOUNT") : undefined;
  const tokenAccounts = buildReferralTokenAccountMap({
    sol: optional(env, "JUPITER_REFERRAL_TOKEN_ACCOUNT_SOL"),
    wsol: optional(env, "JUPITER_REFERRAL_TOKEN_ACCOUNT_WSOL"),
    usdc: optional(env, "JUPITER_REFERRAL_TOKEN_ACCOUNT_USDC"),
    usdt: optional(env, "JUPITER_REFERRAL_TOKEN_ACCOUNT_USDT"),
    extraJson: optional(env, "JUPITER_REFERRAL_TOKEN_ACCOUNTS"),
  });
  const referralRequired = parseBool(optional(env, "JUPITER_REFERRAL_REQUIRED"), false, "JUPITER_REFERRAL_REQUIRED");
  if (!referralAccount) {
    warnings.push(
      "JUPITER_REFERRAL_ACCOUNT is unset, so order requests omit referralAccount and referralFee. No integrator fee is collected.",
    );
  }
  if (referralRequired) {
    if (!referralAccount) throw new ConfigError("JUPITER_REFERRAL_REQUIRED is true but JUPITER_REFERRAL_ACCOUNT is unset");
    for (const [label, mint] of [
      ["SOL", WSOL_MINT],
      ["USDC", USDC_MAINNET_MINT],
      ["USDT", USDT_MAINNET_MINT],
    ] as const) {
      if (!tokenAccounts[mint]) {
        throw new ConfigError(
          `JUPITER_REFERRAL_REQUIRED is true but no referral token account is configured for ${label} (${mint})`,
        );
      }
    }
  }

  const feeCheckRaw = optional(env, "FEE_CHECK_MODE") ?? "fail";
  if (feeCheckRaw !== "fail" && feeCheckRaw !== "warn") {
    throw new ConfigError("FEE_CHECK_MODE must be fail or warn");
  }

  const priceGuardRaw = optional(env, "X402_PRICE_GUARD") ?? "warn";
  if (priceGuardRaw !== "warn" && priceGuardRaw !== "refuse") {
    throw new ConfigError("X402_PRICE_GUARD must be warn or refuse");
  }

  const cluster = parseCluster(optional(env, "X402_NETWORK"));
  const payToRaw = optional(env, "X402_PAY_TO");
  const payTo = payToRaw ? parsePubkey(payToRaw, "X402_PAY_TO") : undefined;
  const cdpConfigured = Boolean(optional(env, "CDP_API_KEY_ID") && optional(env, "CDP_API_KEY_SECRET"));
  const payaiFeeDefault = cluster.cluster === "devnet" ? PAYAI_DEVNET_EXACT_FEE_USD : PAYAI_MAINNET_EXACT_FEE_USD;
  const priceUsd = parsePriceUsd(optional(env, "X402_PRICE_USD"));

  if (!payTo) {
    warnings.push("X402_PAY_TO is unset. token_risk and wallet_portfolio refuse to run until it is set.");
  } else if (!cdpConfigured) {
    warnings.push(
      "CDP_API_KEY_ID and CDP_API_KEY_SECRET are unset. x402 settlements use the PayAI facilitator only.",
    );
  }
  if (optional(env, "SOLANA_KEYPAIR_PATH")) {
    warnings.push(
      "SOLANA_KEYPAIR_PATH is ignored by the Advan server. It is read only by scripts/e2e-devnet-x402.ts.",
    );
  }

  const maxInputRaw = optional(env, "MAX_INPUT_AMOUNT");
  if (maxInputRaw != null && !/^[0-9]+$/.test(maxInputRaw)) {
    throw new ConfigError("MAX_INPUT_AMOUNT must be an integer token amount in base units");
  }

  const allowedHosts = (optional(env, "ADVAN_ALLOWED_HOSTS") ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return {
    host: optional(env, "HOST") ?? "0.0.0.0",
    port: parseIntInRange(optional(env, "PORT"), 8787, "PORT", 1, 65535),
    allowedHosts,
    solanaRpcUrl: optional(env, "SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com",
    rpcTimeoutMs: parseIntInRange(optional(env, "SOLANA_RPC_TIMEOUT_MS"), 15_000, "SOLANA_RPC_TIMEOUT_MS", 1000, 120_000),
    jupiterApiBase: (optional(env, "JUPITER_API_BASE") ?? "https://api.jup.ag").replace(/\/+$/, ""),
    jupiterApiKey: optional(env, "JUPITER_API_KEY"),
    jupiterTimeoutMs: parseIntInRange(optional(env, "JUPITER_TIMEOUT_MS"), 20_000, "JUPITER_TIMEOUT_MS", 1000, 120_000),
    rugcheckBaseUrl: (optional(env, "RUGCHECK_BASE_URL") ?? "https://api.rugcheck.xyz").replace(/\/+$/, ""),
    rugcheckTimeoutMs: parseIntInRange(optional(env, "RUGCHECK_TIMEOUT_MS"), 4_000, "RUGCHECK_TIMEOUT_MS", 500, 30_000),
    referral: {
      account: referralAccount,
      feeBps,
      tokenAccounts,
      required: referralRequired,
    },
    feeCheckMode: feeCheckRaw,
    limits: {
      maxSlippageBps: parseIntInRange(optional(env, "MAX_SLIPPAGE_BPS"), 300, "MAX_SLIPPAGE_BPS", 0, 10_000),
      maxTradeUsd: parsePositive(optional(env, "MAX_TRADE_USD"), "MAX_TRADE_USD"),
      maxInputAmount: maxInputRaw != null ? BigInt(maxInputRaw) : undefined,
      maxPriceImpactPct: parsePositive(optional(env, "MAX_PRICE_IMPACT_PCT"), "MAX_PRICE_IMPACT_PCT") ?? 5,
    },
    swapSelfBroadcastDefault: parseBool(
      optional(env, "SWAP_SELF_BROADCAST_DEFAULT"),
      false,
      "SWAP_SELF_BROADCAST_DEFAULT",
    ),
    x402: {
      payTo,
      priceUsd,
      priceLabel: formatX402Price(priceUsd),
      network: cluster.network,
      cluster: cluster.cluster,
      usdcMint: cluster.usdcMint,
      priceGuard: priceGuardRaw,
      minFeeMultiple: parsePositive(optional(env, "X402_MIN_FEE_MULTIPLE"), "X402_MIN_FEE_MULTIPLE") ?? DEFAULT_FEE_MULTIPLE,
      cdpFeeUsd: parsePositive(optional(env, "X402_CDP_SETTLEMENT_FEE_USD"), "X402_CDP_SETTLEMENT_FEE_USD") ?? CDP_SETTLEMENT_FEE_USD,
      payaiFeeUsd:
        parsePositive(optional(env, "X402_PAYAI_SETTLEMENT_FEE_USD"), "X402_PAYAI_SETTLEMENT_FEE_USD") ?? payaiFeeDefault,
      cdpConfigured,
      facilitatorTimeoutMs: parseIntInRange(
        optional(env, "X402_FACILITATOR_TIMEOUT_MS"),
        90_000,
        "X402_FACILITATOR_TIMEOUT_MS",
        1000,
        120_000,
      ),
      required: parseBool(optional(env, "X402_REQUIRED"), false, "X402_REQUIRED"),
    },
    usageLogPath: optional(env, "USAGE_LOG_PATH") ?? "./logs/usage.jsonl",
    usageLogStdout: parseBool(optional(env, "USAGE_LOG_STDOUT"), false, "USAGE_LOG_STDOUT"),
    warnings,
  };
}
