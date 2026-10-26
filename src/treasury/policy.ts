import { randomUUID } from "node:crypto";

export type TreasuryDecision = "allow" | "approval_required" | "deny";
export interface TreasuryPolicy {
  id: string;
  wallet: string;
  allowedAgents?: string[];
  allowedMints?: string[];
  deniedMints?: string[];
  maxTradeUsd: number;
  dailyExposureUsd: number;
  sessionExposureUsd?: number;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
  maxRiskScore?: number;
  approvalAboveUsd?: number;
}
export interface TreasuryIntent {
  id?: string;
  agentId: string;
  wallet: string;
  inputMint: string;
  outputMint: string;
  amountUsd: number;
  slippageBps: number;
  priceImpactPct: number;
  tokenRiskScore: number;
  routeRiskScore: number;
  protocolRiskScore: number;
  dailyExposureUsd: number;
  sessionExposureUsd?: number;
}
export interface PolicyCheck { name: string; passed: boolean; detail: string; }
export interface TreasuryEvaluation {
  intentId: string;
  policyId: string;
  decision: TreasuryDecision;
  checks: PolicyCheck[];
  riskScore: number;
  evaluatedAt: string;
}
const finiteNonNegative = (n: number) => Number.isFinite(n) && n >= 0;
export function evaluateTreasuryIntent(policy: TreasuryPolicy, intent: TreasuryIntent): TreasuryEvaluation {
  const scores = [intent.tokenRiskScore, intent.routeRiskScore, intent.protocolRiskScore];
  const valid = finiteNonNegative(intent.amountUsd) && finiteNonNegative(intent.dailyExposureUsd)
    && finiteNonNegative(intent.slippageBps) && finiteNonNegative(intent.priceImpactPct)
    && scores.every((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  if (!valid) throw new Error("Intent contains invalid amounts, thresholds, or risk scores");
  if (!policy.id || !policy.wallet || !finiteNonNegative(policy.maxTradeUsd)
    || !finiteNonNegative(policy.dailyExposureUsd) || !finiteNonNegative(policy.maxSlippageBps)
    || !finiteNonNegative(policy.maxPriceImpactPct)) throw new Error("Policy is invalid");
  const checks: PolicyCheck[] = [];
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  check("wallet", intent.wallet === policy.wallet, intent.wallet === policy.wallet ? "Wallet matches policy" : "Wallet is not authorized by policy");
  check("agent", !policy.allowedAgents || policy.allowedAgents.includes(intent.agentId), "Agent permission");
  check("input_asset", !policy.deniedMints?.includes(intent.inputMint) && (!policy.allowedMints || policy.allowedMints.includes(intent.inputMint)), "Input asset allow/deny list");
  check("output_asset", !policy.deniedMints?.includes(intent.outputMint) && (!policy.allowedMints || policy.allowedMints.includes(intent.outputMint)), "Output asset allow/deny list");
  check("max_trade", intent.amountUsd <= policy.maxTradeUsd, `Trade $${intent.amountUsd} / max $${policy.maxTradeUsd}`);
  check("daily_exposure", intent.dailyExposureUsd + intent.amountUsd <= policy.dailyExposureUsd, `Daily exposure after trade $${intent.dailyExposureUsd + intent.amountUsd} / max $${policy.dailyExposureUsd}`);
  if (policy.sessionExposureUsd != null) check("session_exposure", (intent.sessionExposureUsd ?? 0) + intent.amountUsd <= policy.sessionExposureUsd, "Session exposure cap");
  check("slippage", intent.slippageBps <= policy.maxSlippageBps, `Slippage ${intent.slippageBps} bps / max ${policy.maxSlippageBps} bps`);
  check("price_impact", intent.priceImpactPct <= policy.maxPriceImpactPct, `Price impact ${intent.priceImpactPct}% / max ${policy.maxPriceImpactPct}%`);
  const riskScore = Math.round((intent.tokenRiskScore * 0.4 + intent.routeRiskScore * 0.35 + intent.protocolRiskScore * 0.25) * 100) / 100;
  check("risk_score", riskScore <= (policy.maxRiskScore ?? 60), `Composite risk ${riskScore} / max ${policy.maxRiskScore ?? 60}`);
  const failed = checks.some((c) => !c.passed);
  const approval = !failed && policy.approvalAboveUsd != null && intent.amountUsd > policy.approvalAboveUsd;
  return { intentId: intent.id ?? randomUUID(), policyId: policy.id, decision: failed ? "deny" : approval ? "approval_required" : "allow", checks, riskScore, evaluatedAt: new Date().toISOString() };
}
