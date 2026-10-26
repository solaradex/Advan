# Advan Treasury MVP

## Scope and safety boundary
This increment adds a deterministic policy evaluator and an audit-friendly evaluation API without changing existing quote, swap, MCP, or x402 behavior. It is deliberately **non-custodial and evaluation-only**: it does not sign or broadcast transactions, and it does not pretend a policy decision is an on-chain enforcement boundary. Existing `build_swap_tx` remains unsigned.

## Flow
1. A trusted operator supplies a policy and an agent intent to `POST /v1/treasury/evaluate`.
2. The evaluator checks wallet and agent authorization, asset allow/deny lists, per-trade and projected daily/session exposure, slippage, price impact, and weighted token/route/protocol risk.
3. The result is `allow`, `approval_required`, or `deny`, with per-check reasons and a timestamp.
4. The caller records and enforces approvals in its trusted control plane before requesting a swap. Do not treat `approval_required` as permission to execute.

## Request shape
```json
{
  "policy": {
    "id": "treasury-mainnet-v1", "wallet": "<wallet pubkey>",
    "allowedAgents": ["scheduler-agent"],
    "allowedMints": ["<USDC mint>", "<SOL mint>"], "deniedMints": [],
    "maxTradeUsd": 500, "dailyExposureUsd": 2000, "sessionExposureUsd": 800,
    "maxSlippageBps": 100, "maxPriceImpactPct": 1,
    "maxRiskScore": 50, "approvalAboveUsd": 250
  },
  "intent": {
    "agentId": "scheduler-agent", "wallet": "<wallet pubkey>",
    "inputMint": "<input mint>", "outputMint": "<output mint>",
    "amountUsd": 100, "slippageBps": 50, "priceImpactPct": 0.2,
    "tokenRiskScore": 10, "routeRiskScore": 15, "protocolRiskScore": 20,
    "dailyExposureUsd": 100, "sessionExposureUsd": 100
  }
}
```

Risk inputs are supplied by the caller in this MVP; production integration must derive/validate them from existing Jupiter quote and token-risk results rather than trusting agent-provided values. Composite score = 40% token + 35% route + 25% protocol, each score 0–100. Unknown risk must be treated as fail-closed by the integrating caller. Daily/session exposure must come from an authoritative ledger and be reserved atomically to prevent concurrent intents from exceeding caps.

## Production limitations / rollout gates
- No authenticated policy administration, persistent treasury ledger, multi-approver identity, replay protection, or transaction broadcast is added in this first slice.
- Do not expose this endpoint publicly until authentication and server-side policy storage are wired in. Client-submitted policies are not authoritative.
- Before enabling automatic execution, add durable transactional storage, authenticated approval records, idempotency, concurrency-safe exposure reservations, route quote binding, and execution reconciliation.
- No new environment variables are required.
