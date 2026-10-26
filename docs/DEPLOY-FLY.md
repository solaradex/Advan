# Deploy Advan on Fly.io

This deploys the HTTP server (plain JSON and Streamable HTTP MCP on `/mcp`). It does not publish the npm package. Do not commit secrets or `.env` files. Non-secret production values live in `fly.toml`. RPC URLs and API keys are Fly secrets.

The app name in `fly.toml` is `advan`. Change `app` if that name is already taken, then update the placeholder URL in `README.md` and `server.json` to the hostname Fly assigns.

`internal_port` is **8787**, the default of `PORT` in `src/config.ts`. One `shared-cpu-1x` machine with 512 MB runs in `iad`, with `min_machines_running = 1` and `auto_stop_machines = "off"`, so the process stays up. A 1 GB volume named `advan_data` is mounted at `/data`. The image entrypoint `chown`s that directory to the `node` user and then drops root with `su-exec`. `USAGE_LOG_PATH` is `/data/usage.jsonl`.

## 1. Install flyctl

```bash
curl -L https://fly.io/install.sh | sh
fly version
fly auth login
```

## 2. Create the app without deploying

From the repository root, so the existing `fly.toml` is kept:

```bash
fly launch --no-deploy --copy-config
```

`--no-deploy` does not boot a machine. `--copy-config` uses this `fly.toml` instead of generating a new one. If Fly says the name `advan` is taken, edit `app` in `fly.toml` and run the command again.

## 3. Create the volume

Create the volume before the first deploy. `fly.toml` mounts a volume named `advan_data`; deploy fails if none exists in `iad`.

```bash
fly volumes create advan_data --size 1 --region iad
```

`--size 1` is 1 GB. One machine needs one volume. Add another volume in the same region before you scale past one machine.

## 4. Set secrets

These names are the ones `src/config.ts` reads. None of them belong in `fly.toml`.

```bash
fly secrets set \
  SOLANA_RPC_URL="https://YOUR_MAINNET_RPC" \
  X402_RPC_URL="https://YOUR_MAINNET_RPC" \
  JUPITER_API_KEY="YOUR_JUPITER_API_KEY" \
  CDP_API_KEY_ID="YOUR_CDP_API_KEY_ID" \
  CDP_API_KEY_SECRET="YOUR_CDP_API_KEY_SECRET"
```

| Secret | Why it is required |
|---|---|
| `SOLANA_RPC_URL` | RPC for token risk, portfolios, and referral-account checks. Unset, the server uses the public mainnet RPC, which is rate-limited. |
| `X402_RPC_URL` | RPC used only for the x402 payment blockhash. Unset, mainnet payments use `https://api.mainnet-beta.solana.com`. It must be a mainnet endpoint when `X402_NETWORK` is mainnet. It is not `SOLANA_RPC_URL`. |
| `JUPITER_API_KEY` | Sent as `x-api-key`. Unset, Jupiter allows about 0.5 requests per second. |
| `CDP_API_KEY_ID` | Coinbase CDP facilitator (primary). Both CDP values must be set together. |
| `CDP_API_KEY_SECRET` | Coinbase CDP API key secret. |

`X402_REQUIRED=true` in `fly.toml` exits the process if facilitator startup fails. PayAI is the fallback when CDP is down, and it can start with no key. Optional PayAI keys, only after the free credit allowance is used up:

```bash
fly secrets set \
  PAYAI_API_KEY_ID="YOUR_PAYAI_API_KEY_ID" \
  PAYAI_API_KEY_SECRET="YOUR_PAYAI_API_KEY_SECRET"
```

Do not import a development `.env`. That file sets `HOST=127.0.0.1` and a relative usage-log path, which would override the Fly values.

`fly secrets set` restarts existing machines. On a brand-new app, set the secrets before `fly deploy`.

## 5. Deploy

```bash
fly deploy
```

GitHub Actions can deploy the same way. `.github/workflows/fly-deploy.yml` runs only when someone starts it by hand (`workflow_dispatch`). It runs `flyctl deploy --remote-only` with the Actions secret `FLY_API_TOKEN` (`fly tokens create deploy` or `fly auth token`). It does not run on push.

## 6. Verify

Replace the host if you changed the app name. `https://advan.fly.dev` is the placeholder for app name `advan`.

```bash
curl -fsS https://advan.fly.dev/healthz
```

Expect HTTP 200 and JSON `{"status":"ok"}`. `GET /health` is the longer status payload (facilitator, fee, RPC origins). Fly's HTTP check and the image `HEALTHCHECK` both call `GET /healthz`.

Paid routes answer 402 until the client pays. `Accept: application/json` keeps the body JSON:

```bash
curl -sS -D- -o /tmp/advan-402.json -X POST https://advan.fly.dev/v1/token_risk \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -d '{"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'
```

Expect `HTTP/2 402` (or `HTTP/1.1 402` if you call the app without TLS). `POST /v1/wallet_portfolio` is the other paid route. `POST /v1/get_quote` stays free.

```bash
curl -fsS https://advan.fly.dev/stats
```

`/stats` summarizes `/data/usage.jsonl`. A new volume has no events yet, so the counts are zero. That is a successful read of the volume.

```bash
fly status
fly logs
```

The server process is user `node` (uid 1000). A new SSH session is root, so check pid 1 rather than `id` with no arguments:

```bash
fly ssh console -C "cat /proc/1/status"
```
