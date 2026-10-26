#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { boot } from "./boot.js";
import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";

loadDotenv();

const config = loadConfig();
const { ctx, x402 } = await boot(config, { mirrorStdout: config.usageLogStdout });
const app = createApp({ ctx, x402 });
const server = app.listen(config.port, config.host, () => {
  process.stderr.write(`advan: http listening on ${config.host}:${config.port}\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
