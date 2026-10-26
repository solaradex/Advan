import type { AppConfig } from "../config.js";
import type { JupiterClient } from "../jupiter/client.js";
import type { PaymentStatus, UsageLogger } from "../log.js";
import type { RugcheckSummary } from "../risk/score.js";
import type { SolanaRpc } from "../solana/rpc.js";

export interface ToolContext {
  config: AppConfig;
  jupiter: JupiterClient;
  rpc: SolanaRpc;
  rugcheck: (mint: string) => Promise<RugcheckSummary | null>;
  log: UsageLogger;
  paymentStatus: PaymentStatus;
  facilitatorName?: () => string | undefined;
}
