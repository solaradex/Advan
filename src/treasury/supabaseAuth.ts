export interface TreasuryOperator {
  id: string;
  role: string;
  canApprove: boolean;
}

interface SupabaseUser {
  id?: unknown;
  app_metadata?: unknown;
}

/**
 * Verify the bearer token against Supabase Auth's user endpoint.
 * Authorization is derived only from app_metadata, which is controlled by
 * trusted project administrators, never user_metadata.
 */
export async function verifySupabaseTreasuryOperator(input: {
  authorization: string | undefined;
  supabaseUrl: string | undefined;
  anonKey: string | undefined;
  fetcher?: typeof fetch;
}): Promise<TreasuryOperator | null> {
  const match = /^Bearer\s+([^\s]+)$/i.exec(input.authorization ?? "");
  const base = input.supabaseUrl?.trim().replace(/\/$/, "");
  const key = input.anonKey?.trim();
  if (!match || !base || !base.startsWith("https://") || !key) return null;

  try {
    const response = await (input.fetcher ?? fetch)(`${base}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${match[1]}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const user = await response.json() as SupabaseUser;
    if (typeof user.id !== "string" || !user.id.trim()) return null;
    const metadata = user.app_metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const claims = metadata as Record<string, unknown>;
    const role = typeof claims.treasury_role === "string" ? claims.treasury_role : "";
    return {
      id: user.id,
      role,
      canApprove: role === "treasury_approver" || role === "treasury_admin",
    };
  } catch {
    return null;
  }
}
