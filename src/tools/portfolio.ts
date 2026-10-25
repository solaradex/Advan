import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from "../constants.js";
import { execute } from "./execute.js";
import { portfolioSchema } from "./schemas.js";
import type { ToolContext } from "./context.js";

export async function walletPortfolio(input: unknown, ctx: ToolContext) {
  return execute("wallet_portfolio", ctx, async () => {
    const { owner } = portfolioSchema.parse(input);
    const [lamports, spl, token2022] = await Promise.all([
      ctx.rpc.getBalance(owner),
      ctx.rpc.getTokenAccountsByOwner(owner, TOKEN_PROGRAM_ID),
      ctx.rpc.getTokenAccountsByOwner(owner, TOKEN_2022_PROGRAM_ID),
    ]);
    const holdings = [...spl, ...token2022].filter((row) => row.amount !== "0");
    const mints = [WSOL_MINT, ...holdings.map((row) => row.mint)];
    const prices = await ctx.jupiter.prices(mints);
    const meta = new Map<string, { symbol?: string; name?: string }>();
    const unique = [...new Set(holdings.map((row) => row.mint))];
    const listed = await ctx.jupiter.searchTokens(unique).catch(() => []);
    for (const token of listed) meta.set(token.id, { symbol: token.symbol, name: token.name });
    const solPrice = prices[WSOL_MINT]?.usdPrice;
    const solUsd = solPrice == null ? null : (Number(lamports) / 1_000_000_000) * solPrice;
    const tokens = holdings.map((row) => {
      const price = prices[row.mint]?.usdPrice;
      const usdValue = price == null ? null : (Number(row.amount) / 10 ** row.decimals) * price;
      return {
        pubkey: row.pubkey,
        mint: row.mint,
        programId: row.programId,
        symbol: meta.get(row.mint)?.symbol,
        name: meta.get(row.mint)?.name,
        amount: row.amount,
        decimals: row.decimals,
        uiAmount: row.uiAmount,
        state: row.state,
        usdPrice: price ?? null,
        usdValue,
      };
    });
    const unpricedMints = tokens.filter((row) => row.usdValue == null).map((row) => row.mint);
    const tokenUsd = tokens.reduce((sum, row) => sum + (row.usdValue ?? 0), 0);
    return {
      owner,
      sol: {
        lamports: lamports.toString(),
        uiAmount: Number(lamports) / 1_000_000_000,
        usdPrice: solPrice ?? null,
        usdValue: solUsd,
      },
      tokens,
      totalUsd: (solUsd ?? 0) + tokenUsd,
      unpricedMints,
      priced: solUsd != null || tokens.some((row) => row.usdValue != null),
    };
  });
}
