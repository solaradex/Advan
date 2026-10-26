# Advan Treasury MVP — Stage 2

## Authenticated policy and approval control plane

Stage 2 adds a bearer-token-protected policy registry, durable local policy/approval records, an approval queue, one-time approval decisions, and audit events. Existing Jupiter quote, unsigned swap, MCP, and x402 routes remain unchanged.

### Configure
- `TREASURY_API_TOKEN`: required secret for every Treasury endpoint. If absent, Treasury routes return HTTP 503 and are disabled. Use a long random secret; never commit it.
- `TREASURY_STORE_PATH`: optional JSON store path; defaults to `./data/treasury.json`. Audit events go to `<path>.audit.jsonl`. Keep both files on a persistent, private volume and back them up securely.

This file-backed implementation is for a single process / single replica. Atomic file replacement prevents partial JSON writes, but it does **not** provide cross-process transactions, distributed locking, or concurrency-safe exposure reservations. Do not deploy multiple replicas or treat this store as the final production treasury ledger.

### Endpoints
All routes require `Authorization: Bearer <TREASURY_API_TOKEN>`.

- `PUT /v1/treasury/policies/:id` — create/update a trusted policy. Policy `id` must match the URL.
- `GET /v1/treasury/policies/:id` — read a stored policy.
- `POST /v1/treasury/evaluate` — body: `{"policyId":"treasury-v1","intent":{...}}`. The server loads the stored policy; caller-supplied policies are not accepted.
- `GET /v1/treasury/approvals` — list approval requests.
- `POST /v1/treasury/approvals/:id/decision` — body: `{"status":"approved","decidedBy":"operator-id","reason":"optional"}` (or `rejected`). Only pending approvals can be decided once.

Evaluation records and approval events are appended to the audit JSONL file. Approval decisions are authenticated by the shared API token, but `decidedBy` is currently an asserted label, not a verified identity. Use a proper identity provider and role-based authorization before production use.

### Decision semantics
- `deny`: at least one mandatory policy check failed.
- `approval_required`: policy checks passed, but the configured trade approval threshold was crossed. An approval record is created and the response is HTTP 202.
- `allow`: all evaluated checks passed and no approval threshold was crossed.

An approval is a governance record only. It does not execute or authorize an arbitrary transaction. Existing `build_swap_tx` remains unsigned and is not wired to approval state.

### Production gates
1. Move policy, approval, audit, and exposure data to a transactional database (e.g. Postgres) with atomic exposure reservations.
2. Authenticate real operators and assign roles; do not trust `decidedBy` text.
3. Persist the exact immutable intent/quote digest against each approval and reject modified or expired intents.
4. Derive price impact, route and token risk from server-verified Jupiter/RPC data; do not trust agent-supplied risk values.
5. Add idempotency keys, rate limiting, audit retention/rotation, tamper-evident audit storage, and multi-replica concurrency tests.
6. Integrate execution only after the above controls are verified. This stage still does not sign or broadcast transactions.
