#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadDotenv } from "dotenv";
import { boot } from "./boot.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./mcp/server.js";

loadDotenv();

const config = loadConfig();
if (config.usageLogStdout) {
  process.stderr.write("advan: USAGE_LOG_STDOUT is ignored for stdio so MCP messages keep stdout.\n");
}

const { ctx, x402 } = await boot(config, { mirrorStdout: false });
const server = createMcpServer(ctx, x402);
const transport = new StdioServerTransport();
await server.connect(transport);
