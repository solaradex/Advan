import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { SOLANA_DEVNET_CAIP, USDC_MAINNET_MINT } from "../src/constants.js";
import { loadConfig, parsePublicBaseUrl, publicResourceUrl } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { createApp } from "../src/http/app.js";
import { withFreshPayment } from "../src/mcp/server.js";
import { httpDiscovery, type X402Runtime } from "../src/x402/setup.js";
import { FakeJupiter, orderResponse, testConfig, toolContext } from "./helpers.js";

const PAY_TO = "11111111111111111111111111111111";

class StubFacilitator implements FacilitatorClient {
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET_CAIP, extra: { feePayer: PAY_TO } }],
      extensions: [],
      signers: {},
    };
  }

  async verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> {
    return { isValid: false, invalidReason: "invalid_exact_svm_payload_transaction" };
  }

  async settle(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<SettleResponse> {
    return { success: false, errorReason: "invalid_exact_svm_payload_transaction", transaction: "", network: SOLANA_DEVNET_CAIP };
  }
}

interface PaymentChallenge {
  resource?: { url?: string };
  extensions?: { bazaar?: unknown };
}

function rawRequest(
  port: number,
  options: { path: string; method?: string; host: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers: {
          host: options.host,
          accept: "application/json",
          "content-type": "application/json",
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; port: number }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  return { server, port: address.port };
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function challenge(headers: IncomingHttpHeaders): PaymentChallenge {
  const raw = headers["payment-required"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error("missing PAYMENT-REQUIRED");
  return decodePaymentRequiredHeader(value) as PaymentChallenge;
}

async function paidRuntime(): Promise<X402Runtime> {
  const facilitator = new StubFacilitator();
  const resourceServer = new x402ResourceServer(facilitator).register(
    SOLANA_DEVNET_CAIP,
    new ExactSvmScheme({ rpcUrl: "https://api.devnet.solana.com" }),
  );
  await resourceServer.initialize();
  return {
    resourceServer,
    network: SOLANA_DEVNET_CAIP,
    payTo: PAY_TO,
    priceLabel: "$0.02",
    buildAccepts: () =>
      resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP,
        payTo: PAY_TO,
        price: "$0.02",
      }),
  } as X402Runtime;
}

describe("PUBLIC_BASE_URL", () => {
  it("accepts an origin and rejects a path, query, or credentials", () => {
    expect(parsePublicBaseUrl(undefined)).toBeUndefined();
    expect(parsePublicBaseUrl("https://advan.fly.dev")).toBe("https://advan.fly.dev");
    expect(parsePublicBaseUrl("https://advan.fly.dev/")).toBe("https://advan.fly.dev");
    expect(parsePublicBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(publicResourceUrl(undefined, "/v1/token_risk")).toBeUndefined();
    expect(publicResourceUrl("https://advan.fly.dev", "/v1/token_risk")).toBe("https://advan.fly.dev/v1/token_risk");
    expect(publicResourceUrl("https://advan.fly.dev", "v1/wallet_portfolio")).toBe(
      "https://advan.fly.dev/v1/wallet_portfolio",
    );

    for (const value of [
      "advan.fly.dev",
      "ftp://advan.fly.dev",
      "https://advan.fly.dev/v1/token_risk",
      "https://advan.fly.dev/?q=1",
      "https://user:pass@advan.fly.dev",
    ]) {
      expect(() => parsePublicBaseUrl(value), value).toThrow(ConfigError);
      expect(() => loadConfig({ PUBLIC_BASE_URL: value })).toThrow(ConfigError);
    }
  });

  it("sets Express trust proxy only when a public origin is configured", () => {
    const withBase = createApp({
      ctx: toolContext(testConfig({ PUBLIC_BASE_URL: "https://advan.fly.dev/" }), new FakeJupiter(orderResponse())),
      x402: null,
    });
    expect(withBase.get("trust proxy")).toBe(1);

    const without = createApp({
      ctx: toolContext(testConfig(), new FakeJupiter(orderResponse())),
      x402: null,
    });
    expect(without.get("trust proxy")).toBe(false);
  });
});

describe("x402 resource URL", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await close(server);
    server = undefined;
  });

  async function paidApp(extra: NodeJS.ProcessEnv = {}): Promise<number> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { context: { slot: 1 }, value: { blockhash: "block", lastValidBlockHeight: 100 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const x402 = await paidRuntime();
    const app = createApp({
      ctx: toolContext(
        testConfig({ HOST: "0.0.0.0", ADVAN_ALLOWED_HOSTS: "", ...extra }),
        new FakeJupiter(orderResponse()),
      ),
      x402,
    });
    const listening = await listen(app);
    server = listening.server;
    return listening.port;
  }

  it("advertises the public https origin even when the request is http and Host is spoofed", async () => {
    const port = await paidApp({ PUBLIC_BASE_URL: "https://advan.fly.dev" });
    const body = JSON.stringify({ mint: USDC_MAINNET_MINT });
    const risk = await rawRequest(port, {
      path: "/v1/token_risk",
      method: "POST",
      host: "evil.example",
      body,
      headers: { "x-forwarded-proto": "http" },
    });
    expect(risk.status).toBe(402);
    const riskChallenge = challenge(risk.headers);
    expect(riskChallenge.resource?.url).toBe("https://advan.fly.dev/v1/token_risk");
    expect(riskChallenge.extensions?.bazaar).toBeTruthy();
    expect(JSON.stringify(riskChallenge)).not.toContain("http://");
    expect(JSON.stringify(riskChallenge)).not.toContain("evil.example");

    const portfolio = await rawRequest(port, {
      path: "/v1/wallet_portfolio",
      method: "POST",
      host: "evil.example",
      body: JSON.stringify({ owner: PAY_TO }),
    });
    expect(portfolio.status).toBe(402);
    expect(challenge(portfolio.headers).resource?.url).toBe("https://advan.fly.dev/v1/wallet_portfolio");
  });

  it("falls back to the request URL when PUBLIC_BASE_URL is unset", async () => {
    const port = await paidApp();
    const response = await rawRequest(port, {
      path: "/v1/token_risk",
      method: "POST",
      host: "127.0.0.1:9",
      body: JSON.stringify({ mint: USDC_MAINNET_MINT }),
    });
    expect(response.status).toBe(402);
    expect(challenge(response.headers).resource?.url).toBe("http://127.0.0.1:9/v1/token_risk");
  });

  it("puts the public origin on paid MCP payment requirements", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { context: { slot: 1 }, value: { blockhash: "block", lastValidBlockHeight: 100 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const x402 = await paidRuntime();
    const config = testConfig({ PUBLIC_BASE_URL: "https://advan.fly.dev" });
    const handler = withFreshPayment(
      x402,
      {
        description: "token risk",
        mimeType: "application/json",
        url: publicResourceUrl(config.publicBaseUrl, "/v1/token_risk"),
      },
      httpDiscovery("token_risk"),
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    const unpaid = await handler({ mint: USDC_MAINNET_MINT });
    const required = unpaid.structuredContent as PaymentChallenge | undefined;
    expect(required?.resource?.url).toBe("https://advan.fly.dev/v1/token_risk");
    expect(required?.extensions?.bazaar).toBeTruthy();
    expect(JSON.stringify(required)).not.toContain("http://");
    expect(JSON.stringify(required)).not.toContain("mcp://");
  });
});

describe("public host allow-list", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  it("lets Fly probe /healthz on any Host and still rejects other routes", async () => {
    const app = createApp({
      ctx: toolContext(
        testConfig({ HOST: "0.0.0.0", ADVAN_ALLOWED_HOSTS: "advan.fly.dev" }),
        new FakeJupiter(orderResponse()),
      ),
      x402: null,
    });
    const listening = await listen(app);
    server = listening.server;
    const { port } = listening;

    const healthz = await rawRequest(port, { path: "/healthz", host: "10.0.0.1" });
    expect(healthz.status).toBe(200);
    expect(JSON.parse(healthz.body)).toEqual({ status: "ok" });

    const foreign = await rawRequest(port, { path: "/health", host: "10.0.0.1" });
    expect(foreign.status).toBe(403);

    const allowed = await rawRequest(port, { path: "/health", host: "advan.fly.dev" });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body).status).toBe("ok");
  });
});
