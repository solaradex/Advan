import { UpstreamError } from "../errors.js";

export interface MintAccount {
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  tokenProgram: string;
  extensions: string[];
}

export interface TokenHolding {
  pubkey: string;
  mint: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
  state?: string;
  programId: string;
}

export interface LargestAccount {
  address: string;
  amount: string;
  decimals: number;
}

export interface SolanaRpc {
  getBalance(owner: string): Promise<bigint>;
  getMint(mint: string): Promise<MintAccount | null>;
  getTokenAccountsByOwner(owner: string, programId: string): Promise<TokenHolding[]>;
  getTokenLargestAccounts(mint: string): Promise<LargestAccount[]>;
}

export function createSolanaRpc(rpcUrl: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): SolanaRpc {
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UpstreamError(`Solana RPC ${method} failed: ${(error as Error).message}`);
    }
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (!response.ok || body.error) {
      throw new UpstreamError(body.error?.message ?? `Solana RPC ${method} HTTP ${response.status}`);
    }
    return body.result as T;
  }

  return {
    async getBalance(owner) {
      const result = await call<{ value: number }>("getBalance", [owner]);
      return BigInt(result.value);
    },
    async getMint(mint) {
      const result = await call<{ value: RpcAccount | null }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
      if (!result.value) return null;
      const parsed = result.value.data?.parsed;
      if (!parsed || parsed.type !== "mint" || !parsed.info) return null;
      const info = parsed.info;
      const extensions = Array.isArray(info.extensions)
        ? info.extensions
            .map((entry) => (entry && typeof entry.extension === "string" ? entry.extension : ""))
            .filter((name) => name.length > 0)
        : [];
      return {
        decimals: info.decimals ?? 0,
        supply: info.supply ?? "0",
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        tokenProgram: result.value.owner,
        extensions,
      };
    },
    async getTokenAccountsByOwner(owner, programId) {
      const result = await call<{ value: RpcTokenAccount[] }>("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "jsonParsed" },
      ]);
      return (result.value ?? []).map((row) => {
        const info = row.account.data.parsed.info;
        return {
          pubkey: row.pubkey,
          mint: info.mint,
          amount: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          uiAmount: info.tokenAmount.uiAmount,
          state: info.state,
          programId,
        };
      });
    },
    async getTokenLargestAccounts(mint) {
      const result = await call<{ value: LargestAccount[] }>("getTokenLargestAccounts", [mint]);
      return result.value ?? [];
    },
  };
}

interface RpcAccount {
  owner: string;
  data?: {
    parsed?: {
      type?: string;
      info?: {
        decimals?: number;
        supply?: string;
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        extensions?: Array<{ extension?: string }>;
      };
    };
  };
}

interface RpcTokenAccount {
  pubkey: string;
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          state?: string;
          tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
        };
      };
    };
  };
}
