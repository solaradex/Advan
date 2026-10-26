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
    // Native SOL is priced from mainnet wSOL even on devnet: devnet has no SOL/USD book.
    // The request is separate so a batch of unlisted devnet mints cannot drop the SOL price.
    const solQuote = await ctx.jupiter.prices([WSOL_MINT]);
    const tokenMints = [...new Set(holdings.map((row) => row.mint).filter((mint) => mint !== WSOL_MINT))];
    const prices = tokenMints.length > 0 ? await ctx.jupiter.prices(tokenMints) : {};
    prices[WSOL_MINT] = solQuote[WSOL_MINT];
    const meta = new Map<string, { symbol?: string; name?: string }>();
    const unique = [...new Set(holdings.map((row) => row.mint))];
    const listed = await ctx.jupiter.searchTokens(unique).catch(() => []);
    for (const token of listed) meta.set(token.id, { symbol: token.symbol, name: token.name });
    const solPrice = solQuote[WSOL_MINT]?.usdPrice ?? null;
    const solUsd = solPrice == null ? null : (Number(lamports) / 1_000_000_000) * solPrice;
    const priceSource =
      solPrice == null
        ? null
        : ctx.config.dataCluster === "devnet"
          ? "jupiter-price-v3:wSOL (mainnet market; devnet has no SOL/USD book)"
          : "jupiter-price-v3:wSOL";
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
      cluster: ctx.config.dataCluster,
      sol: {
        lamports: lamports.toString(),
        uiAmount: Number(lamports) / 1_000_000_000,
        usdPrice: solPrice,
        usdValue: solUsd,
        priceSource,
      },
      tokens,
      totalUsd: (solUsd ?? 0) + tokenUsd,
      unpricedMints,
      priced: solUsd != null || tokens.some((row) => row.usdValue != null),
    };
  });
}
