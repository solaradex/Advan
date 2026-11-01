import { describe, expect, it } from "vitest";
import { evaluateTreasuryIntent, type TreasuryIntent, type TreasuryPolicy } from "../src/treasury/policy.js";

const policy: TreasuryPolicy = { id: "ops-v1", wallet: "wallet-1", allowedAgents: ["agent-1"], allowedMints: ["USDC", "SOL"], maxTradeUsd: 500, dailyExposureUsd: 1000, sessionExposureUsd: 600, maxSlippageBps: 100, maxPriceImpactPct: 1, maxRiskScore: 50, approvalAboveUsd: 250 };
const intent: TreasuryIntent = { agentId: "agent-1", wallet: "wallet-1", inputMint: "USDC", outputMint: "SOL", amountUsd: 100, slippageBps: 50, priceImpactPct: 0.2, tokenRiskScore: 10, routeRiskScore: 15, protocolRiskScore: 20, dailyExposureUsd: 100, sessionExposureUsd: 100 };
describe("treasury policy", () => {
  it("allows compliant low-impact intent", () => expect(evaluateTreasuryIntent(policy, intent).decision).toBe("allow"));
  it("denies wallet and exposure violations", () => expect(evaluateTreasuryIntent(policy, { ...intent, wallet: "other", dailyExposureUsd: 950 }).decision).toBe("deny"));
  it("requires approval above configured amount", () => expect(evaluateTreasuryIntent(policy, { ...intent, amountUsd: 300 }).decision).toBe("approval_required"));
  it("denies denied assets and excessive slippage", () => expect(evaluateTreasuryIntent({ ...policy, deniedMints: ["SOL"] }, { ...intent, slippageBps: 200 }).decision).toBe("deny"));
  it("rejects invalid risk scores", () => expect(() => evaluateTreasuryIntent(policy, { ...intent, tokenRiskScore: 101 })).toThrow());
});
