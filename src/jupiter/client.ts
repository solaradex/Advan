import { UpstreamError } from "../errors.js";
import type { OrderParams, OrderResponse, PriceInfo, TokenInfo } from "./types.js";

export interface JupiterClient {
  order(params: OrderParams): Promise<OrderResponse>;
  searchToken(mint: string): Promise<TokenInfo | null>;
  searchTokens(mints: string[]): Promise<TokenInfo[]>;
  prices(mints: string[]): Promise<Record<string, PriceInfo | undefined>>;
}

export interface JupiterClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createJupiterClient(options: JupiterClientOptions): JupiterClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) headers["x-api-key"] = options.apiKey;

  const client: JupiterClient = {
    async order(params) {
      const query = new URLSearchParams({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
      });
      if (params.taker) query.set("taker", params.taker);
      if (params.slippageBps != null) query.set("slippageBps", String(params.slippageBps));
      if (params.referralAccount) query.set("referralAccount", params.referralAccount);
      if (params.referralFee != null) query.set("referralFee", String(params.referralFee));
      if (params.excludeRouters) query.set("excludeRouters", params.excludeRouters);
      if (params.receiver) query.set("receiver", params.receiver);
      const body = await getJson(
        fetchImpl,
        `${options.baseUrl}/swap/v2/order?${query.toString()}`,
        { headers },
        options.timeoutMs,
      );
      return parseOrder(body);
    },
    async searchToken(mint) {
      const tokens = await client.searchTokens([mint]);
      return tokens.find((token) => token.id === mint) ?? tokens[0] ?? null;
    },
    async searchTokens(mints) {
      const unique = [...new Set(mints)].slice(0, 100);
      if (unique.length === 0) return [];
      const body = await getJson(
        fetchImpl,
        `${options.baseUrl}/tokens/v2/search?query=${unique.map(encodeURIComponent).join(",")}`,
        { headers },
        options.timeoutMs,
      );
      if (!Array.isArray(body)) return [];
      return body.filter(isRecord).map(parseToken);
    },
    async prices(mints) {
      const unique = [...new Set(mints)];
      const out: Record<string, PriceInfo | undefined> = {};
      for (let index = 0; index < unique.length; index += 50) {
        const batch = unique.slice(index, index + 50);
        const body = await getJson(
          fetchImpl,
          `${options.baseUrl}/price/v3?ids=${batch.map(encodeURIComponent).join(",")}`,
          { headers },
          options.timeoutMs,
        );
        if (!isRecord(body)) continue;
        for (const mint of batch) {
          const row = body[mint];
          if (!isRecord(row) || typeof row.usdPrice !== "number") {
            out[mint] = undefined;
            continue;
          }
          out[mint] = {
            usdPrice: row.usdPrice,
            decimals: typeof row.decimals === "number" ? row.decimals : undefined,
            priceChange24h: typeof row.priceChange24h === "number" ? row.priceChange24h : undefined,
            liquidity: typeof row.liquidity === "number" ? row.liquidity : undefined,
            blockId: typeof row.blockId === "number" ? row.blockId : undefined,
          };
        }
      }
      return out;
    },
  };
  return client;
}

function parseOrder(body: unknown): OrderResponse {
  if (!isRecord(body)) throw new UpstreamError("Jupiter order response was not an object");
  if (typeof body.error === "string" && body.inAmount == null) {
    throw new UpstreamError(`Jupiter order failed: ${body.error}`);
  }
  if (typeof body.inAmount !== "string" || typeof body.outAmount !== "string") {
    throw new UpstreamError("Jupiter order response did not include inAmount and outAmount");
  }
  const errorMessage = typeof body.errorMessage === "string" ? body.errorMessage : null;
  if (errorMessage) throw new UpstreamError(`Jupiter order failed: ${errorMessage}`, { errorCode: body.errorCode });
  const platformFee = isRecord(body.platformFee)
    ? {
        amount: typeof body.platformFee.amount === "string" ? body.platformFee.amount : undefined,
        feeBps: numberOrUndefined(body.platformFee.feeBps),
        feeMint: typeof body.platformFee.feeMint === "string" ? body.platformFee.feeMint : undefined,
      }
    : undefined;
  return {
    transaction: typeof body.transaction === "string" ? body.transaction : body.transaction == null ? null : null,
    requestId: typeof body.requestId === "string" ? body.requestId : undefined,
    inAmount: body.inAmount,
    outAmount: body.outAmount,
    otherAmountThreshold: typeof body.otherAmountThreshold === "string" ? body.otherAmountThreshold : undefined,
    slippageBps: numberOrUndefined(body.slippageBps),
    priceImpactPct: body.priceImpactPct == null ? undefined : String(body.priceImpactPct),
    routePlan: Array.isArray(body.routePlan) ? (body.routePlan as OrderResponse["routePlan"]) : undefined,
    router: typeof body.router === "string" ? body.router : undefined,
    mode: typeof body.mode === "string" ? body.mode : undefined,
    swapType: typeof body.swapType === "string" ? body.swapType : undefined,
    feeBps: numberOrUndefined(body.feeBps),
    feeMint: typeof body.feeMint === "string" ? body.feeMint : undefined,
    platformFee,
    referralAccount: typeof body.referralAccount === "string" ? body.referralAccount : body.referralAccount == null ? null : null,
    gasless: typeof body.gasless === "boolean" ? body.gasless : undefined,
    signatureFeePayer: typeof body.signatureFeePayer === "string" ? body.signatureFeePayer : null,
    lastValidBlockHeight: numberOrUndefined(body.lastValidBlockHeight),
    expireAt: typeof body.expireAt === "string" || typeof body.expireAt === "number" ? body.expireAt : null,
    transactionVersion: typeof body.transactionVersion === "string" ? body.transactionVersion : undefined,
    inputMint: typeof body.inputMint === "string" ? body.inputMint : undefined,
    outputMint: typeof body.outputMint === "string" ? body.outputMint : undefined,
  };
}

function parseToken(row: Record<string, unknown>): TokenInfo {
  const audit = isRecord(row.audit) ? row.audit : undefined;
  return {
    id: String(row.id),
    name: typeof row.name === "string" ? row.name : undefined,
    symbol: typeof row.symbol === "string" ? row.symbol : undefined,
    decimals: numberOrUndefined(row.decimals),
    tokenProgram: typeof row.tokenProgram === "string" ? row.tokenProgram : undefined,
    mintAuthority: typeof row.mintAuthority === "string" ? row.mintAuthority : row.mintAuthority == null ? null : null,
    freezeAuthority:
      typeof row.freezeAuthority === "string" ? row.freezeAuthority : row.freezeAuthority == null ? null : null,
    isVerified: typeof row.isVerified === "boolean" ? row.isVerified : undefined,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
    organicScore: numberOrUndefined(row.organicScore),
    organicScoreLabel: typeof row.organicScoreLabel === "string" ? row.organicScoreLabel : undefined,
    audit: audit
      ? {
          isSus: typeof audit.isSus === "boolean" ? audit.isSus : undefined,
          mintAuthorityDisabled: typeof audit.mintAuthorityDisabled === "boolean" ? audit.mintAuthorityDisabled : undefined,
          freezeAuthorityDisabled:
            typeof audit.freezeAuthorityDisabled === "boolean" ? audit.freezeAuthorityDisabled : undefined,
          topHoldersPercentage: numberOrUndefined(audit.topHoldersPercentage),
          devMints: numberOrUndefined(audit.devMints),
        }
      : undefined,
    usdPrice: numberOrUndefined(row.usdPrice),
    liquidity: numberOrUndefined(row.liquidity),
    holderCount: numberOrUndefined(row.holderCount),
  };
}

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new UpstreamError(`Jupiter request failed: ${(error as Error).message}`);
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new UpstreamError(`Jupiter HTTP ${response.status}`, { url, body });
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
