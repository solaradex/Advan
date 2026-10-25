import { loadConfig, type AppConfig } from "../src/config.js";
import type { JupiterClient } from "../src/jupiter/client.js";
import type { OrderParams, OrderResponse, PriceInfo, TokenInfo } from "../src/jupiter/types.js";
import { MemoryUsageLogger } from "../src/log.js";
import type { SolanaRpc } from "../src/solana/rpc.js";
import type { ToolContext } from "../src/tools/context.js";
import { WSOL_MINT } from "../src/constants.js";

export const REFERRAL = "11111111111111111111111111111111";
export const REFERRAL_TOKEN_ACCOUNT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export function testConfig(extra: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    JUPITER_REFERRAL_ACCOUNT: REFERRAL,
    JUPITER_REFERRAL_FEE_BPS: "50",
    JUPITER_REFERRAL_TOKEN_ACCOUNT_SOL: REFERRAL_TOKEN_ACCOUNT,
    MAX_SLIPPAGE_BPS: "300",
    MAX_PRICE_IMPACT_PCT: "5",
    X402_PAY_TO: "",
    ...extra,
  });
}

export function orderResponse(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    transaction: null,
    requestId: "req-1",
    inAmount: "100000000",
    outAmount: "10000000",
    otherAmountThreshold: "9950000",
    slippageBps: 50,
    priceImpactPct: "0.001",
    feeBps: 50,
    feeMint: WSOL_MINT,
    referralAccount: REFERRAL,
    gasless: false,
    router: "metis",
    swapType: "aggregator",
    inputMint: WSOL_MINT,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ...overrides,
  };
}

export class FakeJupiter implements JupiterClient {
  calls: OrderParams[] = [];
  price: PriceInfo | undefined = { usdPrice: 100, decimals: 9 };

  constructor(public response: OrderResponse) {}

  async order(params: OrderParams): Promise<OrderResponse> {
    this.calls.push(params);
    return this.response;
  }

  async searchToken(): Promise<TokenInfo | null> {
    return null;
  }

  async searchTokens(): Promise<TokenInfo[]> {
    return [];
  }

  async prices(mints: string[]): Promise<Record<string, PriceInfo | undefined>> {
    return Object.fromEntries(mints.map((mint) => [mint, this.price]));
  }
}

export function toolContext(config: AppConfig, jupiter: JupiterClient, log = new MemoryUsageLogger()): ToolContext & { log: MemoryUsageLogger } {
  const rpc: SolanaRpc = {
    async getBalance() {
      return 0n;
    },
    async getMint() {
      return null;
    },
    async getTokenAccountsByOwner() {
      return [];
    },
    async getTokenLargestAccounts() {
      return [];
    },
  };
  return {
    config,
    jupiter,
    rpc,
    rugcheck: async () => null,
    log,
    paymentStatus: "free",
  };
}
