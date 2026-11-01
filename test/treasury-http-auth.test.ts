import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { TreasuryStore } from "../src/treasury/store.js";
import type { TreasuryPolicy } from "../src/treasury/policy.js";
import { FakeJupiter, orderResponse, testConfig, toolContext } from "./helpers.js";

const policy: TreasuryPolicy = {
  id: "ops-v1",
  wallet: "wallet-1",
  allowedAgents: ["agent-1"],
  allowedMints: ["USDC", "SOL"],
  maxTradeUsd: 500,
  dailyExposureUsd: 1000,
  sessionExposureUsd: 600,
  maxSlippageBps: 100,
  maxPriceImpactPct: 1,
  maxRiskScore: 50,
  approvalAboveUsd: 250,
};

describe("treasury HTTP authorization", () => {
  let server: Server | undefined;
  let directory = "";
  let storePath = "";
  let approvalId = "";
  let port = 0;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "advan-treasury-http-"));
    storePath = join(directory, "treasury.json");

    vi.stubEnv("TREASURY_STORE_PATH", storePath);
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_ANON_KEY", "test-anon-key");

    const store = new TreasuryStore(storePath);
    store.putPolicy(policy);
    approvalId = store.createApproval("intent-1", policy.id).id;

    originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/auth/v1/user")) {
        const authorization = new Headers(init?.headers).get("Authorization");
        const token = authorization?.replace(/^Bearer\s+/i, "");

        const users: Record<string, object> = {
          admin: { id: "admin-user", app_metadata: { treasury_role: "treasury_admin" } },
          approver: { id: "approver-user", app_metadata: { treasury_role: "treasury_approver" } },
          ordinary: { id: "ordinary-user", app_metadata: { role: "authenticated" } },
        };

        if (!token || token === "invalid") {
          return new Response("Unauthorized", { status: 401 });
        }

        return new Response(JSON.stringify(users[token] ?? {}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return originalFetch(input, init);
    });

    const app = createApp({
      ctx: toolContext(testConfig(), new FakeJupiter(orderResponse())),
      x402: null,
    });
    server = createServer(app);

    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server port");
    port = address.port;
  });

  afterEach(async () => {
    const current = server;
    server = undefined;

    if (current) {
      await new Promise<void>((resolve, reject) => {
        current.close((error) => error ? reject(error) : resolve());
      });
    }

    vi.restoreAllMocks();
    vi.unstubAllEnvs();

    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  async function request(path: string, token?: string, method = "GET", body?: unknown) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("rejects requests without a bearer token", async () => {
    const response = await request("/v1/treasury/approvals");
    expect(response.status).toBe(401);
  });

  it("rejects invalid Supabase sessions", async () => {
    const response = await request("/v1/treasury/approvals", "invalid");
    expect(response.status).toBe(401);
  });

  it("rejects ordinary authenticated users", async () => {
    const response = await request("/v1/treasury/approvals", "ordinary");
    expect(response.status).toBe(403);
  });

  it("allows approvers to view approvals but not policies", async () => {
    const approvals = await request("/v1/treasury/approvals", "approver");
    expect(approvals.status).toBe(200);

    const policies = await request("/v1/treasury/policies/ops-v1", "approver");
    expect(policies.status).toBe(403);
  });

  it("does not allow approvers to modify policies", async () => {
    const response = await request(
      "/v1/treasury/policies/ops-v1",
      "approver",
      "PUT",
      policy,
    );
    expect(response.status).toBe(403);
  });

  it("records the verified operator, not a forged decidedBy value", async () => {
    const response = await request(
      `/v1/treasury/approvals/${approvalId}/decision`,
      "approver",
      "POST",
      { status: "approved", decidedBy: "forged-user", reason: "HTTP security test" },
    );

    expect(response.status).toBe(200);

    const result = await response.json() as { decidedBy?: string; status?: string };
    expect(result.status).toBe("approved");
    expect(result.decidedBy).toBe("approver-user");

    const persisted = new TreasuryStore(storePath)
      .listApprovals()
      .find((approval) => approval.id === approvalId);

    expect(persisted?.decidedBy).toBe("approver-user");
    expect(persisted?.decidedBy).not.toBe("forged-user");
  });

  it("allows administrators to read treasury policies", async () => {
    const response = await request("/v1/treasury/policies/ops-v1", "admin");
    expect(response.status).toBe(200);

    const result = await response.json() as TreasuryPolicy;
    expect(result.id).toBe("ops-v1");
  });
});
