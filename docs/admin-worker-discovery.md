# Admin Worker multi-source discovery

The five supported adapters and all fifteen access statuses are documented in [Admin Worker discovery sources](admin-worker-sources.md). Ten sources remain disabled and have no runtime transport.

Discovery requires `20261018000100_admin_worker_multi_source.sql`, followed by `20261018000200_admin_worker_source_expansion.sql` and `20261018000300_admin_worker_email_identity_guard.sql`. All three are installed in Production (48 migrations). Application deployment does not start the Worker or enable automated email delivery.

The existing Worker dispatches five read-only, unauthenticated adapters: APIs.guru, [Public API Lists](https://github.com/public-api-lists/public-api-lists), GitHub Public APIs, publicapis.dev's MIT repository and the Apify Store catalog/public profiles. Public API Lists publishes its [JSON dataset](https://public-api-lists.github.io/public-api-lists/api/all.json) under the [MIT license](licenses/public-api-lists.txt); the two additional MIT notices are retained in `docs/licenses/`. Apify Actors are never run, rented or subscribed to. Discovery uses free catalog downloads; existing qualification inference still uses its existing budget.

Candidate slots rotate fairly between enabled sources. The root run number rotates the starting source; Resume keeps the root batch's selection, including previously saved two-source plans. If a source is exhausted or cooling down, healthy sources can continue. Each new Start prioritizes unseen identities within the unconsumed portion of each catalog. Resumes retain the existing order. Pre-upgrade materialized APIs.guru plans finish using their original ordinals.

A service-only source-state table retains bounded normalized catalog snapshots, content-hash revisions, consumed cursors, refresh times and failure cooldowns. Cached snapshots refresh after 24 hours; paginated sources advance through their persisted next-page cursor as pages are consumed. Unchanged revisions retain their cursor. Changed revisions retain consumed IDs and process new IDs without replaying the whole catalog. Existing incomplete investigations remain in the ordinary bounded recovery pipeline; a routine catalog refresh does not reset them.

The observation RPC atomically saves the batch's immutable source work, candidate attribution and source cursor. Replayed observations do not advance twice. Version checks reject stale writers. Run status and deadlines fence writes; source requests also check active state and charge the existing shared source budget, including redirects. Source failures back off from one minute to 24 hours, honoring a longer valid `Retry-After`. Database faults fail closed. No lifecycle functions or controls are replaced.

Accepted observations remain in existing candidate storage until explicitly processed. After fresh ordinals, each logical batch may claim at most five pending source candidates from inactive older batches, within the existing one-minute recovery window and shared budgets. The existing claim ledger and five-minute completion leases prevent overlapping processing. Resume can renew expired leases from that same slice; a separate Start can reclaim unfinished work from a stopped or completed batch. Recovery retains normal finalized-provider and cooldown checks and does not count observations twice.

Every HTTP dispatch attempt, including redirects and retries after uncertain failures, requires a fresh source-budget charge. Each source is capped at 40 requests per logical batch, including Resume, within the existing shared limits. A replayed claim never authorizes another request. Lost claim responses conservatively consume allowance without dispatching HTTP. Persisted catalog responses and observations are reused; missing persistence may require another bounded, freshly charged request.

All catalog records remain assertions. The same provider history, ownership verification, OpenAPI validation, Groq qualification, contact verification and suppression/history checks apply. Dataset documentation links are not automatically OpenAPI contracts. Records lacking a structured contract or current appropriate verified contact evidence cannot enter Pending Emails. The Worker does not send emails. The Pending Emails UI and existing business records are unchanged.

## Local verification

```sh
node --import tsx --require ./tests/admin-worker/mail-list-register.mjs tests/admin-worker/multi-source.test.ts
node --import tsx --require ./tests/admin-worker/mail-list-register.mjs tests/admin-worker/source-expansion.test.ts
python3 tests/admin-worker/multi-source-postgres.py --expanded
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run build
```

PostgreSQL tests create disposable local clusters with no Production connection. For new installations, apply the reviewed additive migrations separately before deploying the application. Sources exceeding the existing response or bounded snapshot limits back off without truncating the catalog or advancing their cursor.
