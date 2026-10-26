export interface PlatformFee {
  amount?: string;
  feeBps?: number;
  feeMint?: string;
}

export interface RouteHop {
  percent?: number;
  bps?: number;
  swapInfo?: {
    label?: string;
    ammKey?: string;
    inputMint?: string;
    outputMint?: string;
  };
}

export interface OrderResponse {
  transaction: string | null;
  requestId?: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan?: RouteHop[];
  router?: string;
  mode?: string;
  swapType?: string;
  feeBps?: number;
  feeMint?: string;
  platformFee?: PlatformFee;
  referralAccount?: string | null;
  gasless?: boolean;
  signatureFeePayer?: string | null;
  lastValidBlockHeight?: number;
  expireAt?: string | number | null;
  transactionVersion?: string;
  errorCode?: number | string | null;
  errorMessage?: string | null;
  inputMint?: string;
  outputMint?: string;
}

export interface OrderParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
  slippageBps?: number;
  referralAccount?: string;
  referralFee?: number;
  excludeRouters?: string;
  receiver?: string;
}

export interface TokenAudit {
  isSus?: boolean;
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  topHoldersPercentage?: number;
  devMints?: number;
}

export interface TokenInfo {
  id: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  tokenProgram?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  isVerified?: boolean;
  tags?: string[];
  organicScore?: number;
  organicScoreLabel?: string;
  audit?: TokenAudit;
  usdPrice?: number;
  liquidity?: number;
  holderCount?: number;
}

export interface PriceInfo {
  usdPrice: number;
  decimals?: number;
  priceChange24h?: number;
  liquidity?: number;
  blockId?: number;
}
