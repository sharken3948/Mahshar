# Free API Worker — Bulk List (Phase 3)

Admin selects Ready to List candidates, chooses FREE or PAID (USDC per call), reviews the selection, and confirms once. The browser sends batches of five through the existing signed Seller session. No Worker run or discovery task calls publication.

The Admin route requires both configured Admin membership and the designated owner wallet. It invokes the existing Seller create, verify and activate handlers, preserving their session, origin, rate-limit, request-contract, outbound-security and sensitive-action checks. Completed Seller verification is reused. Provider responses are mocked in Phase 3 validation; no existing candidate is retested.

Ready eligibility does not require affirmative resale permission: technically qualified UNKNOWN and REVIEW_REQUIRED candidates remain visible, including completed reviews with no terms found. Verified explicit prohibitions remain excluded. PAID publication requires one explicit, initially unchecked owner confirmation covering every selected API. The authenticated owner declares that necessary paid proxy/resale rights have been reviewed and established, including applicable restrictions. Each API receives its own server-stamped owner declaration, bound to its candidate and endpoint. This is an owner statement, not a provider grant or independent Worker verification; underlying classifications and evidence are never upgraded or overwritten. FREE publication requires no PAID rights confirmation. No commercial research is repeated and no additional confirmation screen is added.

`api_listings.free_worker_candidate_id` is unique. The additive migration binds a candidate to its draft and stamps `published_at` in the same transaction that activates the listing. Successful candidates disappear from Ready to List while their evidence and listing reference remain available under All candidates. Failed drafts remain available for retry. A retry reuses the exact existing contract and never silently changes another product. Existing rate-limit Retry-After responses are respected; there is no daily quota.

FREE products use the existing public GET request contract at zero USDC. Their proxy branch performs protected, bounded outbound delivery without settlement, purchases, accounting records or invented wallet identities. Paid proxy branches are retained. Public detail pages accept these associated zero-price products.

## Local migration

`supabase/migrations/20261027212210_free_api_worker_bulk_listing.sql` and `supabase/migrations/20261027214854_free_api_worker_owner_rights_confirmation.sql` are additive. Apply it together with the application changes using normal reviewed deployment conventions. It was applied only to disposable PostgreSQL for this task; Production was not modified.

## Reproducible isolated validation

```sh
FREE_WORKER_PHASE3=1 FREE_WORKER_PHASE2=fixtures FREE_WORKER_BROWSER=1 \
FREE_WORKER_BROWSER_LIBRARY_PATH=/tmp/mahshar-phase1-browser-libs/root/usr/lib/x86_64-linux-gnu \
python3 tests/free-api-worker/postgres.py
```

The harness uses a temporary Unix-socket PostgreSQL cluster, the real route handlers, fixture wallet sessions, synthetic `.example.org` responses, and Playwright against the actual Admin component. It copies the saved 672 ready candidates read-only and publishes only synthetic test candidates. It checks source/data preservation, FREE/PAID prices, owner, visibility, public URLs, partial failure/retry, concurrent duplicate protection, expired/wrong sessions, confirmation, price precision, required sensitive signatures, rate-limit handling and removal from Ready. No real wallet signatures or paid calls occur.

Original Phase 3 results: `isolated-validation/free-api-worker-replacement/bulk-list-phase3/`. Owner-confirmation adjustment results and screenshots: `isolated-validation/free-api-worker-replacement/owner-publication-control/`.

## Changed files

- Admin: `src/app/admin/free-api-worker/{worker-client.tsx,bulk-list.tsx,worker.module.css}`; `src/app/api/admin/free-api-worker/list/route.ts`.
- Candidate integration: `src/lib/free-api-worker/{model.ts,store.ts,listing.ts,free-delivery.ts}`.
- Existing Seller/proxy: `src/app/api/apis/route.ts`, `src/app/api/apis/[id]/route.ts`, `src/app/api/proxy/route.ts`, `src/app/api/proxy/[api_id]/route.ts`.
- Public visibility: `src/lib/seo/{listing.ts,public-catalog.ts}`.
- Additive migration above; tests in `tests/free-api-worker/phase3*`, PostgreSQL harness, and the existing Phase 1 button assertion.
- This document and local `WORKLOG.md`.

Original Phase 3 isolated result (before owner-confirmation adjustment): **9 synthetic listings created and active**, all under the designated owner; **672 original Ready candidates preserved**. Browser, retry/duplicate, ownership/security, FREE delivery and PAID pricing checks passed. TypeScript, five Seller/session/SEO regression files and two x402 integration/settlement regression files passed. No live publication or financial transaction occurred.

Owner-control adjustment validation: all **672 existing Ready candidates** preserved; qualifying IDs from the full saved inventory match the Ready list exactly. A single checkbox covered two PAID APIs, with separate authenticated-owner receipts and unchanged UNKNOWN/REVIEW_REQUIRED findings. FREE required no rights confirmation. The isolated test created 12 synthetic listings: 11 activated and one deliberately left as a draft. Selection/removal, explicit confirmation, partial retries, duplicate prevention and Seller security regressions passed. No live publication or provider calls occurred.
