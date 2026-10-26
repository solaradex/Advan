import { RISKY_TOKEN_2022_EXTENSIONS } from "../constants.js";
import type { TokenInfo } from "../jupiter/types.js";
import type { LargestAccount, MintAccount } from "../solana/rpc.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RugcheckSummary {
  score?: number;
  scoreNormalised?: number;
  risks: Array<{ name?: string; description?: string; level?: string; score?: number }>;
  lpLockedPct?: number;
  tokenProgram?: string;
}

export interface RiskEvidence {
  mint: string;
  rpc: { ok: true; mint: MintAccount; topHoldersPct: number | null } | { ok: false; error: string };
  jupiter: TokenInfo | null;
  rugcheck: RugcheckSummary | null;
}

export interface RiskReason {
  source: "rpc" | "jupiter" | "rugcheck";
  code: string;
  impact: number;
  detail: string;
}

export interface RiskReport {
  mint: string;
  safetyScore: number;
  riskLevel: RiskLevel;
  reasons: RiskReason[];
  authorities: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    tokenProgram?: string;
    extensions: string[];
    source: "rpc" | "jupiter" | "unknown";
  };
  concentration: { topHoldersPct: number | null; source: "rpc" | "jupiter" | "unknown" };
  jupiter: TokenInfo | null;
  rugcheck: RugcheckSummary | null;
  sources: { rpc: "ok" | "error"; jupiter: "ok" | "missing"; rugcheck: "ok" | "missing" };
}

export function topHoldersPct(supply: string, largest: LargestAccount[]): number | null {
  let total = 0n;
  try {
    total = BigInt(supply);
  } catch {
    return null;
  }
  if (total <= 0n) return null;
  const held = largest.reduce((sum, row) => sum + BigInt(row.amount), 0n);
  return (Number(held) / Number(total)) * 100;
}

export function scoreTokenRisk(evidence: RiskEvidence): RiskReport {
  const reasons: RiskReason[] = [];
  let score = 100;
  const deduct = (source: RiskReason["source"], code: string, impact: number, detail: string) => {
    score -= impact;
    reasons.push({ source, code, impact: -impact, detail });
  };

  let mintAuthority: string | null = null;
  let freezeAuthority: string | null = null;
  let extensions: string[] = [];
  let tokenProgram: string | undefined;
  let authoritySource: RiskReport["authorities"]["source"] = "unknown";

  if (!evidence.rpc.ok) {
    deduct("rpc", "rpc_unavailable", 15, evidence.rpc.error);
  } else {
    authoritySource = "rpc";
    mintAuthority = evidence.rpc.mint.mintAuthority;
    freezeAuthority = evidence.rpc.mint.freezeAuthority;
    extensions = evidence.rpc.mint.extensions;
    tokenProgram = evidence.rpc.mint.tokenProgram;
    if (mintAuthority) {
      deduct("rpc", "mint_authority", 30, `Mint authority is set to ${mintAuthority}`);
    }
    if (freezeAuthority) {
      deduct("rpc", "freeze_authority", 25, `Freeze authority is set to ${freezeAuthority}`);
    }
    const risky = extensions.filter((name) =>
      (RISKY_TOKEN_2022_EXTENSIONS as readonly string[]).includes(name),
    );
    const extensionImpact = Math.min(36, risky.length * 12);
    if (extensionImpact > 0) {
      deduct("rpc", "token2022_extensions", extensionImpact, `Token-2022 extensions: ${risky.join(", ")}`);
    }
  }

  if (!evidence.jupiter) {
    deduct("jupiter", "token_unknown", 10, "Jupiter Tokens V2 did not return this mint");
  } else {
    const token = evidence.jupiter;
    if (authoritySource === "unknown") {
      authoritySource = "jupiter";
      if (token.audit?.mintAuthorityDisabled === false) {
        deduct("jupiter", "mint_authority", 30, "Jupiter audit reports mint authority enabled");
      }
      if (token.audit?.freezeAuthorityDisabled === false) {
        deduct("jupiter", "freeze_authority", 25, "Jupiter audit reports freeze authority enabled");
      }
    }
    if (token.isVerified === false) {
      deduct("jupiter", "unverified", 15, "Jupiter has not verified this token");
    }
    if (typeof token.organicScore === "number") {
      if (token.organicScore < 25) deduct("jupiter", "organic_score", 15, `organicScore ${token.organicScore.toFixed(1)}`);
      else if (token.organicScore < 50) deduct("jupiter", "organic_score", 8, `organicScore ${token.organicScore.toFixed(1)}`);
    }
    if (token.audit?.isSus) deduct("jupiter", "sus", 25, "Jupiter audit flagged isSus");
    if (typeof token.liquidity === "number" && token.liquidity < 5_000) {
      deduct("jupiter", "low_liquidity", 10, `liquidity $${token.liquidity.toFixed(0)}`);
    }
  }

  let concentration: RiskReport["concentration"] = { topHoldersPct: null, source: "unknown" };
  if (evidence.rpc.ok && evidence.rpc.topHoldersPct != null) {
    concentration = { topHoldersPct: evidence.rpc.topHoldersPct, source: "rpc" };
  } else if (typeof evidence.jupiter?.audit?.topHoldersPercentage === "number") {
    concentration = { topHoldersPct: evidence.jupiter.audit.topHoldersPercentage, source: "jupiter" };
  }
  if (concentration.topHoldersPct != null) {
    const pct = concentration.topHoldersPct;
    if (pct > 80) deduct(concentration.source === "rpc" ? "rpc" : "jupiter", "holder_concentration", 20, `top holders ${pct.toFixed(1)}%`);
    else if (pct > 50) deduct(concentration.source === "rpc" ? "rpc" : "jupiter", "holder_concentration", 12, `top holders ${pct.toFixed(1)}%`);
    else if (pct > 30) deduct(concentration.source === "rpc" ? "rpc" : "jupiter", "holder_concentration", 6, `top holders ${pct.toFixed(1)}%`);
  }

  if (!evidence.rugcheck) {
    deduct("rugcheck", "rugcheck_unavailable", 5, "RugCheck summary was unavailable");
  } else {
    const normalised = evidence.rugcheck.scoreNormalised;
    if (typeof normalised === "number") {
      if (normalised >= 80) deduct("rugcheck", "rugcheck_score", 25, `score_normalised ${normalised}`);
      else if (normalised >= 50) deduct("rugcheck", "rugcheck_score", 15, `score_normalised ${normalised}`);
      else if (normalised >= 20) deduct("rugcheck", "rugcheck_score", 8, `score_normalised ${normalised}`);
    }
    const riskImpact = Math.min(16, evidence.rugcheck.risks.length * 4);
    if (riskImpact > 0) {
      const names = evidence.rugcheck.risks.map((risk) => risk.name ?? risk.description ?? "risk").slice(0, 6);
      deduct("rugcheck", "rugcheck_risks", riskImpact, names.join("; "));
    }
  }

  const safetyScore = Math.max(0, Math.min(100, Math.round(score)));
  const riskLevel: RiskLevel =
    safetyScore >= 75 ? "low" : safetyScore >= 50 ? "medium" : safetyScore >= 25 ? "high" : "critical";

  return {
    mint: evidence.mint,
    safetyScore,
    riskLevel,
    reasons,
    authorities: { mintAuthority, freezeAuthority, tokenProgram, extensions, source: authoritySource },
    concentration,
    jupiter: evidence.jupiter,
    rugcheck: evidence.rugcheck,
    sources: {
      rpc: evidence.rpc.ok ? "ok" : "error",
      jupiter: evidence.jupiter ? "ok" : "missing",
      rugcheck: evidence.rugcheck ? "ok" : "missing",
    },
  };
}
