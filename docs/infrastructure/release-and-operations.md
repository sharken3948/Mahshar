# Infrastructure protection release handoff

Canonical base: `e77788a7f4342b2e4d23a7b384be38dab13f5759`.
Candidate: `/tmp/mahshar-infrastructure-protection-e77788a7`.
Local only. No commit, push, Production migration, deployment, live configuration, paid request, Worker launch or email has been performed. The original dirty workspace is untouched.

Current release authority: [controlled-release.md](controlled-release.md) and [release-readiness.json](release-readiness.json). The user has explicitly separated HTML/WAF work and classified the unchanged baseline CSS failure as non-blocking.

## Corrections following the BLOCK review

- MCP discovery has its existing 10-second deadline across local loading, SQL and bounded response parsing. Cancellation propagates into Supabase queries and response-body readers. A transport ignoring cancellation cannot hold the caller past the deadline. Indexed `api_id` lookup and in-process discovery remain, replacing up to 101 self-HTTP pages with one listing query.
- New budget reservations time out after 2 seconds and request cancellation. Lease release is best effort, idempotent and bounded to 250 ms, including transports that ignore cancellation. A successful provider result survives release failure; crash leases expire after 60 seconds. Original provider timeouts/retries are unchanged.
- Uncalibrated budgets are **disabled by default** and make no reservation/release RPCs while disabled. Groq receives exactly its canonical SDK parameters, including original output behavior. New daily/concurrency/prompt/output ceilings require explicit operator enablement and explicitly supplied positive values. There are no implicit numeric defaults in enforcement.
- Removed process caches, cross-request coalescing and new CDN TTLs for listing data, including SEO, AI candidates, discovery and latency. Public catalog/discovery/latency responses are `no-store`. No global invalidation service or extra invalidation query is needed. Reads following committed activation/deactivation/edit/delete/price changes see current database state; in-flight reads retain ordinary database concurrency semantics. The existing sitemap revalidation interval (one hour) is unchanged; no immediate sitemap-refresh guarantee is introduced.
- Removed the new 32-pending-read cap and uncalibrated edit/delete and Onramp per-minute/body restrictions. Canonical listing authorization, nonce/configuration fencing, parsing and existing rate limits remain. Public SQL bounds remain (catalog/SEO at most 1,000 rows by default; explicit catalog limits at most 100, optional public offset 0–10,000). Owner reads retain canonical scope and behavior.
- Corrected the agent contract test to inspect and verify the delegated discovery implementation. Repaired historical migration test boundaries and the native ESM fixture loader. Original security/visibility assertions are retained. The unrelated baseline CSS assertion is not weakened or silently repaired.

## Budgets: prepared, explicitly inactive

No verified Production peak/request/token/concurrency history was available to calibrate new policy. The old proposed 30/minute, eight-slot and daily budgets are not treated as approved defaults. Their synthetic test values are confined to `tests/infrastructure/policy-fixture.ts`. In particular, the previous 2,000,000-unit background allocation would have allowed at most 217 default-output reservations before prompt overhead; request counts alone are not capacity.

Before enabling any budget, review normal aggregate peaks, burst/concurrency shape, retries, all Groq consumers and provider capacity; approve every ceiling; run mixed normal/boundary workloads in staging using mocks. Enabling protection necessarily introduces explicit 429/503 behavior for the scoped optional resource. Missing/invalid ceilings fail closed only when that policy is explicitly enabled. A flag is enabled only by the literal string `true`; absent flags preserve baseline operation without extra budget database load.

| Policy flag | Required positive integer settings |
|---|---|
| `MAHSHAR_GROQ_BUDGET_ENABLED` | `MAHSHAR_GROQ_REQUESTS_MINUTE`, `MAHSHAR_GROQ_REQUESTS_DAY`, `MAHSHAR_GROQ_UNITS_DAY`, `MAHSHAR_GROQ_CONCURRENCY`, `MAHSHAR_GROQ_MAX_OUTPUT_TOKENS`, `MAHSHAR_GROQ_MAX_PROMPT_BYTES`, and `MAHSHAR_GROQ_{MATCH,SCORE,BACKGROUND}_{REQUESTS_DAY,UNITS_DAY}` |
| `MAHSHAR_LISTING_CREATE_BUDGET_ENABLED` | `MAHSHAR_LISTING_CREATE_GLOBAL_DAY`, `MAHSHAR_LISTING_CREATE_WALLET_DAY` |
| `MAHSHAR_VERIFICATION_BUDGET_ENABLED` | `MAHSHAR_VERIFICATION_GLOBAL_DAY`, `MAHSHAR_VERIFICATION_WALLET_DAY`, `MAHSHAR_VERIFICATION_CONCURRENCY` |
| `MAHSHAR_ONRAMP_BUDGET_ENABLED` | `MAHSHAR_ONRAMP_GLOBAL_DAY`, `MAHSHAR_ONRAMP_WALLET_DAY`, `MAHSHAR_ONRAMP_CONCURRENCY` |

Concurrency is 1–32; other limits are 1–100,000,000, constrained further by actual provider/model capacity. Groq reserves serialized UTF-8 prompt bytes + 1,024 framing units + configured output ceiling (or a smaller caller-requested output). Units are conservative application allocations, not provider-reported tokens or an exact dollar cap. Failures/timeouts are not refunded. Global scopes are shared across IPs, wallets and regions. Wallet-specific scopes are hashed. UTC aligned windows permit boundary bursts. The Groq policy covers public matching, Seller score/retry, legacy discovery, Worker qualification and outreach intelligence. Verification policy covers both score endpoint tests and explicit verification; Onramp policy covers session creation; listing policy covers public creation, not privileged importers. No new budget is added to financial verification, settlement, withdrawal, reconciliation, purchase access or recovery.

For each admitted Groq/verification/Onramp operation there is one reservation and one release RPC; listing creation needs one reservation. Roll back an individual budget by removing its enable flag. Do not delete counters to restore access. Policies stay disabled for the initial compatibility release.

## Migration, cleanup and rollback

There are 52 unchanged canonical migrations plus one additive migration: `20261021000100_resource_cost_protection.sql`. No further migration was introduced for these corrections. It creates only two operational tables, their indexes and three service-only RPCs. Existing financial, authorization and historical migration sources remain byte-identical to the canonical base.

The new retention RPC deletes only `resource_budget_buckets` (expired by another day), `resource_budget_leases` (expired) and `mahshar_rate_limits` (older than two days). No financial/settlement/purchase/replay/withdrawal/recovery record is a target or cascade dependency. Non-empty aged financial/recovery fixtures and snapshots of every other public table verify preservation. Original expired response-body and wallet-auth cleanup semantics are unchanged. New operational cleanup runs only after that authenticated maintenance work succeeds; it is isolated on failure, limited to five batches of at most 1,000 rows/table, and bounded to 2.5 seconds total with cancellation. Large backlogs may require separately approved bounded runs; do not switch to unbounded deletion.

Release order, each requiring separate authorization:

1. Confirm the actual Production project, baseline SHA, migration ledger and recovery readiness. Obtain an encrypted backup and restore it into a disposable environment; never guess a project association or backup availability.
2. Apply **only** the additive migration transactionally. Do not replay or edit the 52 historical migrations. Lock/statement timeout failure aborts and requires rescheduling.
3. Run `scripts/infrastructure/rate-limit-retention-index.sql` **outside a transaction** using concurrent indexing. Verify the exact `bucket_start` definition and valid/ready state. Cleanup skips rate-limit rows until that index is valid. Failed concurrent builds can leave an invalid index; inspect and separately approve removal of only that invalid new index before retrying.
4. Deploy only the reviewed candidate, with new budget flags absent. Never transfer test credentials, font mocks, network guards or `NODE_OPTIONS` into runtime configuration.
5. Observe normal human/agent traffic, current listing visibility, existing authenticated cron, payment/recovery availability and resource metrics. No synthetic payments, listings, emails or Worker runs are authorized.

Immediate application rollback is the recorded baseline deployment. Leave additive operational tables/index dormant; no financial rollback or record deletion is required. Disabling flags removes budget enforcement independently. Any later provider-setting work needs its own separately approved rollback; none is changed here.

## Remaining live configuration and exposure

`provider-controls.json` is a human handoff, not an applied configuration or executable publisher. Actual account settings remain UNKNOWN unless explicitly marked as a prior observation.

- HTML/WAF work is outside this release. No firewall changes or challenges are included.
- **Groq:** Confirm organization/project tier, other consumers, model request/token limits, supported spend cap and alert recipients. Aggregate application controls remain inactive pending calibrated approval; provider limits/alerts are not configured here.
- **Supabase:** Confirm actual project, compute/connection/storage/quota headroom, alerts, existing authenticated daily cron and secret, backup/restore readiness. Prior observations of Free/PITR disabled/no listed backups are historical evidence, not a current recovery guarantee.
- **Circle/Arc/Bridge/Onramp:** Confirm provider/RPC quotas and alerts with headroom for settlement and recovery. Money-moving behavior, RPC selection, signatures, accounting and response recovery remain unchanged.
- **Workflow/Queues, Brevo, Cloudflare, Helius and WalletConnect:** Confirm quotas/usage/alerts, trigger exposure and appropriate origin restrictions. Acquisition/send gates and existing Admin/Worker security are retained. No service is launched or contacted for a paid test.

`scripts/infrastructure/resource-health.sql` is prepared read-only monitoring SQL, not an installed monitor. Configure owner-approved quota thresholds and recipients separately. Track Vercel functions/CPU/transfer, Supabase pressure/backlog, provider usage, 429/503 and maintenance failures. Use baseline application rollback if the new release harms legitimate operations; keep payment reconciliation, withdrawals and purchase recovery available.

## Reproduction and evidence

- Full offline TypeScript inventory: `python3 tests/infrastructure/full-regression.py` (isolated per-file fixtures, external-network guard, scrubbed credentials).
- All disposable PostgreSQL entrypoints and embedded Worker suites: `python3 tests/infrastructure/database-regression.py` (local Unix sockets only; sandbox permission may be required).
- Financial/security/migration integrity: `python3 tests/infrastructure/release-integrity.py`.
- Optimized offline Next build and TypeScript validation: `python3 tests/infrastructure/build-offline.py`.

Final counts and known baseline failures are recorded in `verification-report.json`. Offline tests do not prove live provider quality, account limits or deployed behavior. All deployment, migration and provider changes remain approval-bound.

## Final correction results

1,165/1,166 TypeScript tests passed across all 133 files; no candidate-specific failure remains. The unchanged canonical typography assertion in `tests/dashboard/presentation.test.ts` still fails on existing sub-13px CSS. All eight database entrypoints (including embedded suites), 45 resource/cleanup checks, optimized build and TypeScript validation pass. No test assertion was suppressed or weakened.

Infrastructure compatibility corrections are complete locally. The baseline CSS failure is documented as non-blocking under the latest user instruction; no UI or test assertion was changed. Local encrypted recovery and release-gate rehearsal passed. Production execution remains **BLOCKED only on unverified real recovery/binding prerequisites**, not CSS or excluded HTML/WAF work. New budgets remain disabled. See the controlled release procedure for exact approvals, migration/index ordering, verification and rollback.

The additional offline recovery rehearsal is `python3 tests/infrastructure/recovery-rehearsal.py`; it is included in the database runner and uses installed PostgreSQL/GPG tools with temporary synthetic databases and keys. These are test/operator dependencies, not application dependencies. Production tooling and actual backup receipt remain operator prerequisites.
