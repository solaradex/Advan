import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearerAuthorized, TreasuryStore } from "../src/treasury/store.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("Treasury store", () => {
  it("compares bearer tokens safely and rejects missing configuration", () => {
    expect(bearerAuthorized("Bearer secret", "secret")).toBe(true);
    expect(bearerAuthorized("Bearer wrong", "secret")).toBe(false);
    expect(bearerAuthorized("secret", "secret")).toBe(false);
    expect(bearerAuthorized("Bearer secret", undefined)).toBe(false);
  });
  it("persists policy and approval state across store instances", () => {
    dir = mkdtempSync(join(tmpdir(), "advan-treasury-"));
    const path = join(dir, "treasury.json");
    const store = new TreasuryStore(path);
    store.putPolicy({ id: "p1", wallet: "wallet", maxTradeUsd: 50, dailyExposureUsd: 100, maxSlippageBps: 100, maxPriceImpactPct: 1 });
    expect(new TreasuryStore(path).getPolicy("p1")?.wallet).toBe("wallet");
    const approval = store.createApproval("intent-1", "p1");
    expect(store.decideApproval(approval.id, "approved", "operator-1").status).toBe("approved");
    expect(() => store.decideApproval(approval.id, "rejected", "operator-2")).toThrow(/already decided/);
    expect(new TreasuryStore(path).listApprovals()[0]?.status).toBe("approved");
  });
});
