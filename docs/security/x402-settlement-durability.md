# x402 settlement durability

## Scope and installed SDK evidence

The active v2 endpoints are `POST /api/proxy` and `GET|POST /api/proxy/[api_id]`. They build server-owned requirements, call `gateway.verifyAndSettlePayment`, then proxy and log the API call. The installed `@circle-fin/x402-batching` server runtime exposes `verify`, `settle`, and `getSupported`. Its `callSettle` issues one POST to `/v1/x402/settle` and returns parsed JSON. It has no read-only authorization/settlement status query. The declared transaction field is a string, but runtime validation checks only the presence of `success`; an empty/missing transaction must therefore be handled explicitly. No SDK code, Arc provider selection, private-mainnet header, payout, or verification policy was changed.

The older `POST /api/payments/x402` endpoint is a separate v1-style upstream forwarding path with no repository callers. It reconstructs timestamps rather than accepting the original signed authorization and treats an upstream response as settlement evidence. It cannot be safely mapped to the verified Circle v2 principal/requirements. The user approved retirement: this handler now returns 410 before reading or forwarding a signature, with the current v2 proxy endpoints as the replacement. It does not redirect requests or create payments.

## State machine and failure boundaries

| Boundary | Durable behavior |
| --- | --- |
| Before verification/prepare | No settlement. Invalid proof fails verification; storage failure returns 503. |
| Verified authorization | `PREPARED` stores immutable financial fields and a hash of the authorization proof. No raw signature/private key is stored. |
| Before Circle settle | Only a committed `PREPARED → SETTLEMENT_SUBMITTED` CAS permits one caller to invoke settle. No lease expiry permits resubmission. |
| Explicit rejection/already-used | `SETTLEMENT_UNKNOWN` with a distinct rejection reason, then `MANUAL_REVIEW`; no guessed duplicate or automatic resubmission. |
| Thrown/lost settlement response | `SETTLEMENT_UNKNOWN`; if that write also fails, the committed submission marker remains. |
| Successful Circle response | Save `SETTLEMENT_CONFIRMED` in a separate committed call before accounting. Validate payer/network against verified requirements. |
| Purchase INSERT failure | Confirmation remains intact; return accounting-unavailable 503, never “duplicate payment.” |
| Recovery/concurrent recovery | Lock attempt; insert/recover one purchase by unique attempt identity; validate its immutable financial fields; mark `ACCOUNTING_COMPLETE` in the same transaction. |
| Crash after confirmed | Trusted recovery needs only the database attempt. No browser signature or new settlement. |
| Crash after accounting but before delivery claim | Delivery remains `NOT_STARTED`; exact proof/request replay may acquire the one delivery claim without resettlement. |
| Crash after delivery claim | A stale `IN_PROGRESS` claim becomes `UNKNOWN`; it is never automatically executed again. |
| Upstream pre-dispatch policy/DNS failure | `FAILED_RETRYABLE`; exact proof and request hash may acquire a new delivery claim. |
| Upstream timeout/transport ambiguity | `UNKNOWN`; accounting remains durable and upstream is not rerun. |
| Upstream 4xx/5xx/redirect/oversize | `FAILED_FINAL`; accounting remains durable and upstream is not rerun. |
| Upstream 2xx | `SUCCEEDED`; replay returns status/capability and points to stored-response retrieval without rerunning upstream. |

Pending/recovery failures use 409 or 503, not a new 402 payment challenge. A verified payer is required before settlement. Exact existing authorization replays are located before `/verify`, because an already-used authorization may no longer verify. The stored proof hash and listing/seller binding must match. Changed listing price does not rewrite a previously verified attempt's frozen financial amounts.

## Identity and accounting

The authorization key binds the supported network, fixed asset, verifying contract/domain, payer, and nonce. A unique key prevents changed amount/signature/listing fields from turning the same nonce into another local submission. The SHA-256 payment fingerprint binds canonical authorization fields, including recipient, amount, validity window, and nonce, plus the fixed domain. The listing and seller are immutable database binding fields, deliberately not another way to create a fresh payment identity.

When Circle supplies a transaction/payment ID, it is retained verbatim in `transaction_id`. The canonical ledger identity combines that ID, network, and payment fingerprint: batching must not collapse distinct authorizations sharing one transaction. With no ID, `x402:<fingerprint>` is the deterministic identity, and is used only after a positive verified settlement acknowledgement. There is no timestamp-generated financial identity.

New purchases reference a unique `settlement_attempt_id`. Their existing `tx_hash` field carries the canonical ledger identity, which is not necessarily an explorer transaction hash; Circle's external ID is in the attempt. Existing purchases and nullable historical seller shares are unchanged. Collision with a historical raw transaction ID is fenced for manual review, not guessed as a match. Buyer atomic units retain existing 10% fee rounding; seller atomic units retain existing 10% seller fee rounding; platform units are the exact difference. Existing earnings/withdrawal consumers continue to sum the single durable purchase's seller share.

## Recovery interfaces and limitations

* `POST /api/payments/reconcile` accepts only `{ "attemptId": "uuid" }`, uses the browser wallet session, and scopes the lookup to its authenticated payer. It accepts no client evidence, amounts, transaction IDs, or state changes.
* `reconcileIncompleteSettlements(limit)` in `src/lib/payments/server.ts` is the trusted server/job entry point and does not depend on a browser/session. It scans incomplete attempts and calls the same service-only `x402_recover(uuid)` function. No scheduler was deployed.
* Database table mutation is denied to anon/authenticated and direct service-role writes; only restricted functions transition attempts. The database is the bookkeeping serialization boundary.
* A submission still unresolved after two minutes is marked `MANUAL_REVIEW`, **not** treated as unsuccessful. This age is an operational review threshold, not settlement evidence. A late acknowledgement from the original in-flight claimant can still confirm with its private server submission token; another caller cannot claim it again.
* A crash after Circle succeeds but before the confirmation commit cannot be independently resolved by this installed SDK. The durable authorization/submission obligation survives, but the success acknowledgement/transaction ID may be unavailable. Obtain authoritative Circle evidence tied to the exact stored authorization before any separately reviewed resolution. Never resettle to discover the outcome; no public manual-confirmation override exists.
* Delivery recovery uses the same payment proof and an immutable method/path/body hash. It never authorizes another settlement. Only a proven pre-dispatch failure is retryable; unknown and final outcomes require operator/product resolution rather than guessing or automatic refund.

## Migration and local verification

Migration `20260923000300_x402_settlement_durability.sql` is additive. It requires the existing purchases seller-share column. No historical ownership or financial identity is backfilled. Deployments must drain the old settlement handler before enabling the new code; no migration can retrospectively recover an old process's unrecorded external acknowledgement. Without the migration, new settlement attempts fail closed before Circle settlement.

Migration `20260926000200_x402_delivery_state.sql` adds the delivery lease and completion state. Existing attempts are marked `UNKNOWN`, not `NOT_STARTED`, because their historical upstream side effects cannot be proven absent. New attempts default to `NOT_STARTED`. The delivery functions are service-role-only and bind every retry to a SHA-256 hash of API ID, method, dynamic path, and canonical JSON body.

The rollback under `supabase/rollbacks/` is for unused installations and refuses to drop any financial attempt evidence. No remote migration or deployment was performed.

Focused commands:

```
node --import tsx tests/x402/settlement.test.ts
node --import tsx --import ./tests/x402/register.mjs tests/x402/integration.test.ts
python3 tests/x402/postgres.py
```

The PostgreSQL test uses a fresh temporary cluster, a private Unix socket, and no TCP listener. It never opens existing canary databases. Integration fixtures forbid wallet/RPC/payout clients and replace facilitator/database/upstream boundaries; they exercise the real gateway, pricing, proxy handlers, and recovery validation without live financial calls.
