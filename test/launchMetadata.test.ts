import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USDC_MAINNET_MINT, USDT_MAINNET_MINT, WSOL_MINT } from "../src/constants.js";
import { loadConfig } from "../src/config.js";

const SECRET_NAMES = [
  "SOLANA_RPC_URL",
  "X402_RPC_URL",
  "JUPITER_API_KEY",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "PAYAI_API_KEY_ID",
  "PAYAI_API_KEY_SECRET",
] as const;

function readFlyEnv(toml: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inEnv = false;
  for (const line of toml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inEnv = trimmed === "[env]";
      continue;
    }
    if (!inEnv) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(trimmed);
    if (!match) throw new Error(`unparsed fly.toml env line: ${trimmed}`);
    env[match[1]] = match[2];
  }
  return env;
}

describe("launch metadata", () => {
  it("loads the Fly [env] block with the names the server reads", () => {
    const toml = readFileSync("fly.toml", "utf8");
    const env = readFlyEnv(toml);
    for (const name of SECRET_NAMES) {
      expect(env[name]).toBeUndefined();
      expect(toml).not.toContain(`${name} =`);
    }
    expect(toml).toContain('app = "advan"');
    expect(toml).toContain('primary_region = "iad"');
    expect(toml).toContain("internal_port = 8787");
    expect(toml).toContain("force_https = true");
    expect(toml).toContain('auto_stop_machines = "off"');
    expect(toml).toContain("min_machines_running = 1");
    expect(toml).toContain('size = "shared-cpu-1x"');
    expect(toml).toContain('memory = "512mb"');
    expect(toml).toContain('source = "advan_data"');
    expect(toml).toContain('destination = "/data"');
    expect(toml).toContain('path = "/healthz"');
    expect(toml).toContain('grace_period = "60s"');
    expect(toml).not.toContain('grace_period = "120s"');

    const config = loadConfig(env);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8787);
    expect(config.allowedHosts).toEqual(["advan.fly.dev"]);
    expect(config.publicBaseUrl).toBe("https://advan.fly.dev");
    expect(config.usageLogPath).toBe("/data/usage.jsonl");
    expect(config.x402.network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(config.x402.priceUsd).toBe(0.02);
    expect(config.x402.payTo).toBe("2q4EwekHtit3BtzL25NmGbWJ5khPkmypYbba2t3A4XtM");
    expect(config.x402.priceGuard).toBe("refuse");
    expect(config.x402.required).toBe(true);
    expect(config.referral.feeBps).toBe(100);
    expect(config.referral.required).toBe(true);
    expect(config.referral.account).toBe("ATM2jhwQNPa4kWQ3EfSKxmtPwhWCFag2y1Vgu1BgjA3j");
    expect(config.referral.tokenAccounts[WSOL_MINT]).toBe("BjmGPtkMy8E1C7LDCJ5KPiLh8RRwokCXbW6f1DHqJDaV");
    expect(config.referral.tokenAccounts[USDC_MAINNET_MINT]).toBe("6vLiBn4jWUfhzqnbj4WmzksUHKHRYdQcDLAiYQBEYbsN");
    expect(config.referral.tokenAccounts[USDT_MAINNET_MINT]).toBe("9eM5odqFY3xte4z5CYW2nrwZh2fr3psRBXWWmrqQMJN9");
  });

  it("matches package.json mcpName to the registry server.json draft", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      name: string;
      version: string;
      mcpName: string;
      files: string[];
      repository: { type: string; url: string };
      homepage: string;
      bugs: { url: string };
      keywords: string[];
      bin: Record<string, string>;
    };
    const server = JSON.parse(readFileSync("server.json", "utf8")) as {
      $schema: string;
      name: string;
      description: string;
      version: string;
      packages: Array<{
        registryType: string;
        registryBaseUrl: string;
        identifier: string;
        version: string;
        runtimeHint: string;
        transport: { type: string };
      }>;
      remotes: Array<{ type: string; url: string }>;
    };

    expect(pkg.mcpName).toBe("io.github.solaradex/advan");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/solaradex/Advan.git",
    });
    expect(pkg.homepage).toBe("https://github.com/solaradex/Advan");
    expect(pkg.bugs.url).toBe("https://github.com/solaradex/Advan/issues");
    expect(pkg.keywords).toEqual(["mcp", "solana", "jupiter", "x402", "ai-agents", "trading"]);
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(pkg.bin).toEqual({ "advan-mcp": "dist/index.js" });

    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: "advan-mcp",
      version: pkg.version,
      runtimeHint: "npx",
      transport: { type: "stdio" },
    });
    expect(server.remotes).toEqual([{ type: "streamable-http", url: "https://advan.fly.dev/mcp" }]);
  });
});
