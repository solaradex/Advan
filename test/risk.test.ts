import { describe, expect, it } from "vitest";
import { scoreTokenRisk, topHoldersPct } from "../src/risk/score.js";

describe("token risk score", () => {
  it("scores a verified mint with disabled authorities as low risk", () => {
    const report = scoreTokenRisk({
      mint: "mint",
      rpc: {
        ok: true,
        topHoldersPct: 2,
        mint: {
          decimals: 6,
          supply: "100",
          mintAuthority: null,
          freezeAuthority: null,
          tokenProgram: "token",
          extensions: [],
        },
      },
      jupiter: { id: "mint", isVerified: true, organicScore: 90, liquidity: 1_000_000, symbol: "USDC" },
      rugcheck: { score: 1, scoreNormalised: 1, risks: [] },
    });
    expect(report.riskLevel).toBe("low");
    expect(report.safetyScore).toBeGreaterThanOrEqual(90);
  });

  it("penalises an active mint authority, a suspicious flag, and holder concentration", () => {
    const report = scoreTokenRisk({
      mint: "mint",
      rpc: {
        ok: true,
        topHoldersPct: 92,
        mint: {
          decimals: 9,
          supply: "1000",
          mintAuthority: "authority",
          freezeAuthority: "freezer",
          tokenProgram: "token2022",
          extensions: ["transferFeeConfig", "permanentDelegate"],
        },
      },
      jupiter: { id: "mint", isVerified: false, organicScore: 10, audit: { isSus: true }, liquidity: 100 },
      rugcheck: {
        scoreNormalised: 90,
        risks: [{ name: "mutable" }, { name: "low lp" }],
        score: 90,
      },
    });
    expect(report.riskLevel).toBe("critical");
    expect(report.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["mint_authority", "freeze_authority", "token2022_extensions", "sus", "holder_concentration"]),
    );
    expect(topHoldersPct("1000", [{ address: "a", amount: "800", decimals: 9 }])).toBeCloseTo(80);
  });
});