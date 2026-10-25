import type { AppConfig } from "./config.js";
import { createJupiterClient } from "./jupiter/client.js";
import { JsonlUsageLogger, type UsageLogger } from "./log.js";
import type { RugcheckSummary } from "./risk/score.js";
import { createSolanaRpc } from "./solana/rpc.js";
import type { ToolContext } from "./tools/context.js";

export function createRuntime(config: AppConfig, options?: { mirrorStdout?: boolean; log?: UsageLogger }): ToolContext {
  const log = options?.log ?? new JsonlUsageLogger(config.usageLogPath, options?.mirrorStdout ?? false);
  return {
    config,
    jupiter: createJupiterClient({
      baseUrl: config.jupiterApiBase,
      apiKey: config.jupiterApiKey,
      timeoutMs: config.jupiterTimeoutMs,
    }),
    rpc: createSolanaRpc(config.solanaRpcUrl, config.rpcTimeoutMs),
    rugcheck: (mint) => fetchRugcheck(config.rugcheckBaseUrl, mint, config.rugcheckTimeoutMs),
    log,
    paymentStatus: "free",
  };
}

export async function fetchRugcheck(baseUrl: string, mint: string, timeoutMs: number): Promise<RugcheckSummary | null> {
  try {
    const response = await fetch(`${baseUrl}/v1/tokens/${encodeURIComponent(mint)}/report/summary`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const risks = Array.isArray(body.risks)
      ? body.risks
          .filter((risk): risk is Record<string, unknown> => Boolean(risk) && typeof risk === "object")
          .map((risk) => ({
            name: typeof risk.name === "string" ? risk.name : undefined,
            description: typeof risk.description === "string" ? risk.description : undefined,
            level: typeof risk.level === "string" ? risk.level : undefined,
            score: typeof risk.score === "number" ? risk.score : undefined,
          }))
      : [];
    return {
      score: typeof body.score === "number" ? body.score : undefined,
      scoreNormalised: typeof body.score_normalised === "number" ? body.score_normalised : undefined,
      risks,
      lpLockedPct: typeof body.lpLockedPct === "number" ? body.lpLockedPct : undefined,
      tokenProgram: typeof body.tokenProgram === "string" ? body.tokenProgram : undefined,
    };
  } catch {
    return null;
  }
}
