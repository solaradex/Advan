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


## Stage 3 — execution authorization primitives (in progress)

The feature branch now includes `src/treasury/executionGuard.ts`, a pure authorization primitive that binds an intent to its policy ID, wallet, mints, amount, quote response, transaction-message digest, and expiry. It canonicalizes JSON before computing a SHA-256 intent digest, derives a transaction-message digest by decoding the Solana transaction, and checks approval status, matching verified approver identity, expiry, and exact digest equality before authorization.

Tests in `test/treasury-execution-guard.test.ts` cover pending approvals, changed quote data, approver mismatch, expiry, malformed transaction input, and non-JSON values.

**This is not yet wired into `build_swap_tx` or a transaction submission route.** The existing endpoint still returns unsigned transactions and the service still does not sign or broadcast. A caller must not treat these primitives as proof of authorization until the following work is complete:

1. Store bound approvals and intent records transactionally, including one-time state transitions.
2. Authenticate approvers through a real identity provider and enforce roles server-side.
3. Decode the actual unsigned transaction and verify the fee payer, required signers, swap instructions, input/output mints, amounts, destination, and allowed programs against the approved intent. The digest must be calculated from the exact transaction message the wallet will sign.
4. Re-fetch/validate quote expiry and trusted risk data immediately before returning an authorized transaction.
5. Atomically reserve daily/session exposure before authorization, release on failed/expired intents, and reconcile completed swaps from confirmed chain data.
6. Add idempotency, replay prevention, audit integrity controls, and tests against concurrent requests and transaction tampering.

Until these controls are implemented and tested, Stage 3 remains development-only and must not be marketed as production-safe autonomous execution.


## Stage 3 ledger — persistent approvals and exposure reservations

Added `src/treasury/ledger.ts` and `test/treasury-ledger.test.ts`.

The ledger persists reservations and quote-bound approval records in one JSON document. Each write is performed while holding an exclusive directory lock, followed by an atomic rename. This serializes cooperating processes sharing a local filesystem and prevents two concurrent reservations from independently passing the same exposure check. Reservation calls require an idempotency key; retries return the original reservation only when the intent and amount match. Reusing a key for another intent fails closed.

Daily and optional session exposure checks include all active `reserved` and `committed` reservations. Rejected or expired approvals release their still-reserved exposure. `authorizeOnce` verifies the persisted approved intent, expiry, digest, operator identity, and reservation state, then changes the reservation from `reserved` to `committed` atomically with the ledger write. A second authorization attempt fails because the reservation is no longer reservable.

### Important limits

- This is a single-host/local-filesystem coordination primitive, **not a production distributed database**. It is not appropriate for NFS, multi-host deployments, or horizontally scaled services. A Postgres transaction with row locks/serializable isolation and unique idempotency constraints is still required for production.
- A committed reservation means the authorization slot has been consumed; it does not prove a swap landed on-chain. A separate reconciler must release failed transactions when safe and reconcile confirmed swaps before exposure accounting can be considered authoritative.
- The operator object passed to the ledger must be created by trusted authentication middleware. The ledger does not authenticate users itself.
- The ledger is not yet connected to HTTP endpoints or `build_swap_tx`; it does not sign or broadcast. Do not treat the current public swap endpoint as governed by this ledger.
- File locks have no automatic stale-lock recovery after an abrupt process kill. If the lock remains, operations fail with a retry-safe busy error rather than ignoring the lock.
