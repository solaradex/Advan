import { describe, expect, it, vi } from "vitest";
import { verifySupabaseTreasuryOperator } from "../src/treasury/supabaseAuth.js";

const response = (body: unknown, ok = true) => ({
  ok, json: async () => body,
}) as Response;

describe("Supabase Treasury operator verification", () => {
  const base = {
    authorization: "Bearer signed-user-token",
    supabaseUrl: "https://example.supabase.co",
    anonKey: "public-anon-key",
  };

  it("derives approval permission from trusted app_metadata", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      id: "user-123", app_metadata: { treasury_role: "treasury_approver" },
      user_metadata: { treasury_role: "treasury_admin" },
    }));
    await expect(verifySupabaseTreasuryOperator({ ...base, fetcher }))
      .resolves.toEqual({ id: "user-123", role: "treasury_approver", canApprove: true });
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.supabase.co/auth/v1/user",
      expect.objectContaining({ method: "GET", headers: {
        apikey: "public-anon-key", Authorization: "Bearer signed-user-token",
      } }),
    );
  });

  it("does not grant approval from user_metadata or an ordinary authenticated role", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      id: "user-123", app_metadata: { role: "authenticated" },
      user_metadata: { treasury_role: "treasury_admin" },
    }));
    await expect(verifySupabaseTreasuryOperator({ ...base, fetcher }))
      .resolves.toEqual({ id: "user-123", role: "", canApprove: false });
  });

  it("rejects missing, malformed, or invalid credentials", async () => {
    await expect(verifySupabaseTreasuryOperator({ ...base, authorization: undefined })).resolves.toBeNull();
    await expect(verifySupabaseTreasuryOperator({ ...base, authorization: "Bearer a b" })).resolves.toBeNull();
    const fetcher = vi.fn().mockResolvedValue(response({ message: "invalid token" }, false));
    await expect(verifySupabaseTreasuryOperator({ ...base, fetcher })).resolves.toBeNull();
  });

  it("fails closed on network errors and missing configuration", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(verifySupabaseTreasuryOperator({ ...base, fetcher })).resolves.toBeNull();
    await expect(verifySupabaseTreasuryOperator({ ...base, anonKey: undefined })).resolves.toBeNull();
  });
});
