import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { FakeJupiter, orderResponse, testConfig, toolContext } from "./helpers.js";

describe("GET /healthz", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const current = server;
    server = undefined;
    if (!current) return;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function listen(): Promise<number> {
    const app = createApp({
      ctx: toolContext(testConfig(), new FakeJupiter(orderResponse())),
      x402: null,
    });
    const httpServer = createServer(app);
    server = httpServer;
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    return address.port;
  }

  it("returns 200 JSON", async () => {
    const port = await listen();
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("keeps GET /health on 200 JSON", async () => {
    const port = await listen();
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });
});
