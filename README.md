# Advan

Advan is an open-source [MCP](https://modelcontextprotocol.io) server and HTTP API that gives AI agents Solana trading tools. Quotes and unsigned swap transactions come from Jupiter Swap API V2. Token risk and wallet portfolio reads are paid with [x402](https://www.x402.org) (exact scheme, USDC).

The server is non-custodial. It never signs a transaction and it never loads a trading key. `build_swap_tx` returns an unsigned base64 transaction for the user's own wallet (`taker`) to sign. `SOLANA_KEYPAIR_PATH` is read only by `scripts/e2e-devnet-x402.ts`.

Package name: `advan-mcp` (unregistered on npm when this tree was created on 2026-10-25). Change the `"name"` field in `package.json` before publishing. The `advan-mcp` bin name can stay.

## Fees

**Fees (hosted endpoint):** Swaps built through Advan include a 1.00% (100 bps) platform fee via Jupiter's referral program. Jupiter keeps 20% of that fee, so Advan nets 0.80%. The fee shows in every quote (`platformFee`) before you sign. `token_risk` and `wallet_portfolio` cost **$0.02 USDC per call** via x402 (Solana mainnet). Quotes are free. Non-custodial: you sign every transaction in your own wallet; Advan never holds keys or funds. Self-hosted copies charge nothing unless the operator sets their own fee.

## Hosted endpoint

- `https://advan.fly.dev`
- Streamable HTTP MCP: `https://advan.fly.dev/mcp`

`PUBLIC_BASE_URL` is that origin. x402 resource URLs and Bazaar metadata use it, because Fly terminates TLS and the app would otherwise advertise `http://`.

Deploy steps are in [docs/DEPLOY-FLY.md](docs/DEPLOY-FLY.md).

## What you can call

| Tool | Price | What it does |
|---|---|---|
| `get_quote` | Free | Jupiter `GET /swap/v2/order` without `taker`. Quote only. |
| `build_swap_tx` | Free | Same endpoint with `taker`. Unsigned transaction plus a submit hint. |
| `token_risk` | `X402_PRICE_USD` (default $0.01) | RPC mint/freeze authority, Jupiter Tokens V2, RugCheck summary, scored. |
| `wallet_portfolio` | same | `getBalance` + `getTokenAccountsByOwner` (Token and Token-2022), Jupiter Price V3. |

Jupiter base URL is `https://api.jup.ag` (Swap API V2). `lite-api.jup.ag` is not used. An optional `JUPITER_API_KEY` is sent as `x-api-key`. Keyless access is about 0.5 requests per second; Jupiter returns HTTP 429 past that, and Advan retries those responses with backoff (up to three waits). Set `JUPITER_API_KEY` for production. A portal key is the limit you should run with once more than one agent is calling.

## Fees you should expect

**Jupiter referral.** When `JUPITER_REFERRAL_ACCOUNT` is set, every order sends `referralAccount` and `referralFee`. The allowed range is **50–255 bps** (default **50**). Jupiter keeps 20% of that fee, so 50 bps charged to the user nets **40 bps** to the referral partner, and it replaces Jupiter's usual 2–10 bps platform fee. Quotes will look more expensive than calling Jupiter with no referral.

Jupiter picks the fee mint (SOL, then stables, then LSTs, then other tokens). If the referral token account for that mint does not exist, the swap still succeeds and **your fee is dropped**. Advan checks every order response:

- `referralAccount` matches the configured account
- `feeBps` equals the configured fee when `gasless` is false
- `feeBps` is at least the configured fee when `gasless` is true (gasless cost can add bps)
- `feeMint` has a configured referral token account, and that account is the V2 associated token account of the referral account for the mint (`allowOwnerOffCurve`, under the mint's token program, Token or Token-2022). That is what `initializeReferralTokenAccountV2` creates. A swapped account fails the check. A legacy `referral_ata` PDA is accepted only when that account already exists on-chain.
- At startup Advan checks that each configured referral token account exists on `SOLANA_RPC_URL`. A missing V2 account is recorded. A wrong account, or a legacy PDA that does not exist, refuses to boot.

`FEE_CHECK_MODE=fail` (default) withholds the quote and the transaction when the fee itself is wrong. `warn` returns them with `feeCheck.ok: false` and logs a `fee_check_failure` event either way.

A token-to-token route can pick a `feeMint` you have not created an account for. `REFERRAL_MISSING_MINT_MODE=requote` (default) quotes that pair again **without** `referralAccount` / `referralFee`, returns the quote, and writes a `referral_requote` log line. `fail` refuses the swap. `warn` returns the original order with `feeCheck.ok: false`. Add the mint with `REFERRAL_MINTS` on `npm run setup:referral` if you want the fee on that pair.

Leave the account unset and orders are sent with no referral (a startup warning says so). `JUPITER_REFERRAL_REQUIRED=true` refuses to boot without the account and wSOL, USDC, and USDT token accounts.

**x402.** `token_risk` and `wallet_portfolio` use the exact scheme. The buyer pays USDC to `X402_PAY_TO` on `X402_NETWORK`. Default network is Solana devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) and devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Mainnet is `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` and USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. The recipient USDC token account must already exist (`npm run setup:payto-ata`).

`@x402/evm` is a dependency because `@coinbase/cdp-sdk/x402` loads it. Advan registers only the Solana exact scheme.

Coinbase CDP is the primary facilitator when `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set. PayAI (`https://facilitator.payai.network`) is used when the CDP `/supported` probe fails, and it is the only facilitator when CDP keys are absent. Verify and settle are sent to the facilitator whose advertised `extra.feePayer` is on the payment requirements. An in-flight payment is not handed to the other facilitator: that fee payer would not match, and the settlement would fail. When CDP fails in a way that is safe to fail over, Advan marks it down and the next payment challenge is rebuilt with PayAI's fee payer. The next probe is scheduled for `X402_CDP_RECOVERY_INTERVAL_MS` after the failure (default 5 minutes), not on a timer that started at boot. A healthy `/supported` restores CDP as primary, reloads payment requirements, and writes a `facilitator_recovered` log line. If that reload fails or times out, Advan goes back to PayAI and reloads those requirements instead of leaving them empty. Every fee payer a facilitator has advertised is kept, so a rotated CDP fee payer still settles with CDP. `GET /health` reports `cdp` as `primary`, `down`, or `unconfigured`, and `cdpNextProbeAt` while it is down. A settle timeout or HTTP 5xx is not treated as a failover. Failed verifications are logged as `x402_verification` with the facilitator's reason. The 402 body and `PAYMENT-REQUIRED` error shown to the client say `payment could not be verified`.

MCP payment requirements, including the Solana blockhash, are built on every paid call. HTTP builds them per request. Both use `X402_RPC_URL`, which defaults from `X402_NETWORK` and is never `SOLANA_RPC_URL`.

CDP's published fee after the free tier is $0.001 per successful settlement. PayAI Solana mainnet exact is $0.00133. Devnet PayAI settlements are free. At startup Advan warns, or exits when `X402_PRICE_GUARD=refuse`, if the price is below `X402_MIN_FEE_MULTIPLE` (default 5) times the applicable fee. $0.01 is about 7.5× the PayAI mainnet fee. $0.005 is not.

`get_quote` and `build_swap_tx` are not gated.

## Guards

Before a quote or transaction is returned:

- requested `slippageBps` must be ≤ `MAX_SLIPPAGE_BPS` (default 300)
- if the client omits slippage, Jupiter's RTSE value in the response must still be ≤ the max
- `amount` must be ≤ `MAX_INPUT_AMOUNT` when that cap is set (base units). Unset prints a startup warning.
- USD size (`amount` × Jupiter Price V3) must be ≤ `MAX_TRADE_USD` (default **1000**). Set `MAX_TRADE_USD=off` to disable it. A missing price refuses the trade while the cap is on. Startup warns loudly if both caps are off.
- absolute price impact must be ≤ `MAX_PRICE_IMPACT_PCT` (default 5). Jupiter's `priceImpactPct` is treated as a fraction

## Swap signing

`build_swap_tx` defaults to the managed path (`SWAP_SELF_BROADCAST_DEFAULT=false`):

- JupiterZ (RFQ) routes are allowed. They need the market maker's co-signature, which Jupiter adds during `POST https://api.jup.ag/swap/v2/execute` with `{ signedTransaction, requestId }`.
- The response includes `submit.method: "jupiter"`, `requestId`, and `coSignRequired` when the router is `jupiterz`.
- The transaction field is unsigned. Sign it with the taker wallet, then send it to `/execute` promptly (`lastValidBlockHeight` or `expireAt`).

Pass `selfBroadcast: true` (or set the env default) to send `excludeRouters=jupiterz`. The tool then rejects a `signatureFeePayer` other than the taker, and rejects a response that is still a JupiterZ route. The taker signs and broadcasts that transaction on their own RPC.

## Install

Node.js 20 or newer.

```bash
npm install
npm run build
cp .env.example .env
```

Stdio (Claude Desktop, Cursor, or `npx` after publish):

```bash
npm start
# or, once published:
npx advan-mcp
```

HTTP (plain JSON and Streamable HTTP MCP on `/mcp`):

```bash
npm run start:http
# listens on $HOST:$PORT, default 127.0.0.1:8787
# Docker sets HOST=0.0.0.0. Set ADVAN_ALLOWED_HOSTS when you bind a public interface.
```

Docker:

```bash
docker build -t advan .
docker run --env-file .env -p 8787:8787 advan
```

The image default for `USAGE_LOG_PATH` is `/data/usage.jsonl`. The entrypoint starts as root, `chown`s `/data` to `node` (and creates `/data` when no volume is mounted), then `su-exec` runs the server as `node`. Mount a volume to keep the usage log:

```bash
docker run --env-file .env -p 8787:8787 -v advan-data:/data advan
```

A development `.env` copied from `.env.example` sets `HOST=127.0.0.1`, which hides the port from outside the container. For a published port, set `HOST=0.0.0.0` in that env file or pass `-e HOST=0.0.0.0`. Fly sets `HOST` in `fly.toml`.

The image runs the HTTP server only. Referral setup scripts run from a checkout (`npm install` includes the Jupiter referral SDK as a dev dependency).

## Claude Desktop and Cursor

Paid tools need an x402-aware client. Claude Desktop and Cursor will see a payment-required (or payments-unconfigured) error for `token_risk` and `wallet_portfolio`. Use them for `get_quote` and `build_swap_tx`, and use `scripts/e2e-devnet-x402.ts` or `createx402MCPClient` for paid tools.

Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "advan": {
      "command": "node",
      "args": ["/absolute/path/to/advan/dist/index.js"],
      "env": {
        "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
        "JUPITER_API_KEY": "",
        "JUPITER_REFERRAL_ACCOUNT": "",
        "JUPITER_REFERRAL_FEE_BPS": "50",
        "JUPITER_REFERRAL_TOKEN_ACCOUNT_SOL": "",
        "JUPITER_REFERRAL_TOKEN_ACCOUNT_USDC": "",
        "JUPITER_REFERRAL_TOKEN_ACCOUNT_USDT": "",
        "MAX_SLIPPAGE_BPS": "300",
        "MAX_TRADE_USD": "1000",
        "X402_PAY_TO": "",
        "X402_PRICE_USD": "0.01",
        "X402_NETWORK": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        "CDP_API_KEY_ID": "",
        "CDP_API_KEY_SECRET": ""
      }
    }
  }
}
```

Cursor `.cursor/mcp.json` uses the same `mcpServers` object. During development you can point `command` at `npx` with args `["tsx", "src/index.ts"]` from the repo root.

## HTTP API

`POST` bodies are JSON. Free routes return the tool result. Paid routes answer **402** with `PAYMENT-REQUIRED` until the client retries with `PAYMENT-SIGNATURE` (x402 V2). A browser without a wallet gets the facilitator paywall HTML; API clients that send `Accept: application/json` also get a JSON body from `unpaidResponseBody`.

| Method | Path | Body |
|---|---|---|
| GET | `/health` | — |
| GET | `/healthz` | — |
| GET | `/stats` | — |
| POST | `/v1/get_quote` | `{ "inputMint", "outputMint", "amount", "slippageBps"? }` |
| POST | `/v1/build_swap_tx` | quote fields plus `taker`, optional `selfBroadcast`, optional `receiver` |
| POST | `/v1/token_risk` | `{ "mint" }` |
| POST | `/v1/wallet_portfolio` | `{ "owner" }` |
| POST | `/v1/treasury/evaluate` | `{ "policy": {...}, "intent": {...} }` — deterministic policy evaluation; never signs or broadcasts |
| POST | `/mcp` | Streamable HTTP MCP (stateless JSON responses) |

`amount` is an integer string in base units. Addresses are base58. `slippageBps` is an integer 0–10000, then capped by `MAX_SLIPPAGE_BPS`.

Example:

```bash
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/get_quote \
  -H 'content-type: application/json' \
  -d '{"inputMint":"So11111111111111111111111111111111111111112","outputMint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amount":"10000000"}'
```

`/stats` summarizes the JSONL usage log: calls, calls today (UTC), errors, `fee_check_failure` rows, x402 verifies / settlements / failed settlements, USDC base units received, and an **estimate** of integrator referral fees (80% of `feeBps` on the fee mint). On-chain accrued fees are the referral token-account balances (referral.jup.ag or `npm run claim:referral`), not that estimate.

Each log line is one JSON object with `kind` of `tool`, `fee_check_failure`, `referral_requote`, `x402_settlement`, `x402_verification`, `facilitator_failover`, or `facilitator_recovered`, plus `tool`, `ts`, `latencyMs`, `success`, `error`, `errorCode`, `paymentStatus`, `facilitator`, `feeBps`, `feeMint`, `estimatedIntegratorFeeRaw`, and `usdcAtomic` where they apply. `/health` reports the data RPC origin and the x402 RPC origin separately.

## Referral setup

From a checkout (needs the dev dependency `@jup-ag/referral-sdk`):

```bash
REFERRAL_PAYER_PUBKEY=<your wallet> REFERRAL_NAME=advan npm run setup:referral
```

The script prints unsigned transactions (referral account, then wSOL, USDC, and USDT token accounts) using Jupiter's referral project `DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc`. Sign and send them in order from that wallet. Put the printed referral account and token accounts into `.env`. Optional `REFERRAL_MINTS` adds more fee mints. `REFERRAL_PARTNER_PUBKEY` defaults to the payer.

```bash
REFERRAL_PAYER_PUBKEY=<partner> JUPITER_REFERRAL_ACCOUNT=<account> npm run claim:referral
```

That prints unsigned `claimAllV2` transactions. Nothing is signed in either script.

## Devnet x402 test

1. Create a keypair and request devnet SOL only if you need it for the ATA setup. The x402 exact scheme uses the facilitator as the fee payer, so the buyer needs devnet USDC, not SOL, to pay for a call.
2. Get devnet USDC from the Circle faucet (Solana Devnet), mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
3. Create the payee USDC account (unsigned; sign it yourself). This script uses `X402_RPC_URL`, or the public RPC for `X402_NETWORK` when that is unset. It does not read `SOLANA_RPC_URL`.

```bash
X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 \
X402_PAY_TO=<payee pubkey> \
REFERRAL_PAYER_PUBKEY=<account that pays rent> \
X402_RPC_URL=https://api.devnet.solana.com \
npm run setup:payto-ata
```

4. Start the HTTP server with `X402_PAY_TO` and `X402_NETWORK` (devnet). Leave `SOLANA_RPC_URL` on mainnet if `token_risk` should read mainnet mints. Set `X402_RPC_URL` only when the public devnet RPC is not the one you want; when it is unset Advan derives `https://api.devnet.solana.com` from the devnet CAIP id. Do not point `X402_RPC_URL` at mainnet. Use CDP keys or leave them unset (PayAI, free on devnet). `X402_PRICE_USD` can be `0.01` or `0.005`.
5. Pay from the buyer keypair. `X402_CLIENT_RPC_URL` is the buyer's RPC for the USDC transfer. The public devnet RPC is often unreachable, so set one you can use. The script pays for `token_risk` and `wallet_portfolio`. `E2E_MINT` defaults to devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) when `X402_NETWORK` is devnet, and to mainnet USDC otherwise.

```bash
SOLANA_KEYPAIR_PATH=./devnet-payer.json \
ADVAN_HTTP_URL=http://127.0.0.1:8787 \
X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 \
X402_CLIENT_RPC_URL=https://api.devnet.solana.com \
npm run e2e:devnet
```

`token_risk` and `wallet_portfolio` read `SOLANA_RPC_URL` (mainnet by default). The payment blockhash comes only from `X402_RPC_URL`. Native SOL in a devnet portfolio is still priced from Jupiter's mainnet wSOL market, because devnet has no SOL/USD book. The response field `sol.priceSource` says which one was used.

MCP smoke test (stdio and Streamable HTTP: lists tools, optionally hits Jupiter for `get_quote` and `build_swap_tx`, and parses the unpaid `token_risk` payment-required payload):

```bash
npm run smoke:mcp
SKIP_LIVE=1 npm run smoke:mcp
```

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs those four steps on Node 20. Unit tests mock Jupiter, RPC, and facilitators.

## Open decisions

These are configuration, not hardcoded wallets:

- **Referral fee** defaults to the 50 bps minimum. Raising it (up to 255) earns more and makes quotes less competitive. Jupiter keeps 20%.
- **x402 price** defaults to $0.01 so a PayAI mainnet settlement ($0.00133) stays under about 13% of the price. Set `X402_PRICE_USD=0.005` if you accept a tighter margin; mainnet will warn at the 5× check.
- **Package name** `advan-mcp` looked free on 2026-10-25. `.github/workflows/npm-publish.yml` publishes it on a GitHub release (or a manual workflow run). Publishing still needs an npm token stored as `NPM_TOKEN`.
- **Hosting** for Fly.io is in `fly.toml` and [docs/DEPLOY-FLY.md](docs/DEPLOY-FLY.md). The Dockerfile listens on 8787. Put a real RPC URL in `SOLANA_RPC_URL` before production traffic; `api.mainnet-beta.solana.com` is rate-limited.
- **CDP** keys are free to create. The first 1,000 successful settlements each month are free, then $0.001. Whether devnet settlements count toward that quota is not stated in the CDP docs.
- **PayAI** includes 1,000 free credits total (not monthly). Devnet settlements are free. Topping up is a spending decision.
- **Self-broadcast default** is off so JupiterZ can compete. Turn `SWAP_SELF_BROADCAST_DEFAULT` on if every client broadcasts its own transaction.
- **`FEE_CHECK_MODE`** defaults to `fail`. Use `warn` only if you would rather return a transaction whose integrator fee did not stick.
- **`X402_PRICE_GUARD`** defaults to `warn`. Set `refuse` in production if a too-low price should stop the process.


## Advan Treasury (MVP policy evaluator)

The first Treasury slice adds `POST /v1/treasury/evaluate` and `src/treasury/policy.ts`. It evaluates wallet/agent permissions, asset allow/deny lists, per-trade and projected daily/session exposure, slippage, price impact, and a weighted risk score, returning `allow`, `approval_required`, or `deny` with individual checks. Each evaluation is appended to `${USAGE_LOG_PATH}.treasury.jsonl` when file logging is configured. See [docs/TREASURY-MVP.md](docs/TREASURY-MVP.md) for the request schema and rollout limitations.

**Important:** this is an evaluation-only foundation, not yet a production authorization boundary. Policies and risk inputs are submitted by the caller, there is no authentication or durable exposure reservation, and the result does not authorize signing/broadcasting. Do not expose the endpoint publicly or enable automatic execution until trusted policy storage, authentication, authoritative risk inputs, atomic exposure accounting, and approval identity are implemented. Existing swap tools remain non-custodial and unchanged.
