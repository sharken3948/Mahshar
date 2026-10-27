# Free API Worker production release

This release is based on current `origin/main` and preserves its Seller authentication, provider OAuth, resource-admission, payment and accounting behavior. Only Worker integration changes are carried over from the earlier local development tree. Canary history and local validation data are excluded.

## Schema

Production had no `free_api_*` or `free_worker_*` tables at preparation time. Apply only `20261027222323_free_api_worker_production_additive.sql` through the versioned migration process. It creates the final Worker schema and adds nullable listing association/owner-declaration columns. It does not delete legacy objects or update existing Marketplace/financial records. Its intermediate function/index replacements operate only on objects created in this same migration. Default Worker status is `stopped`.

Do not apply the historical destructive replacement migration. The local Phase 1–3 migrations are consolidated here for a non-destructive first installation, with no qualification or runtime workflow redesign.

## Data

`scripts/free-api-worker-import.mts` exports `loadReleaseInventory` and `importReleaseInventory` for the verified offline snapshot. The snapshot contains 3,925 retained identities and exactly 672 Ready candidates, including the original historical aliases. Excluded identities are retained to prevent rediscovery. Import uses the existing `free_worker_import` RPC in batches of 50; it never starts the Worker or calls a provider. Existing completed results and manual-removal tombstones are not overwritten. Ready identity mismatches and conflicting evidence are reported.

Offline source files and evidence remain outside Git and deployment bundles. Expected Ready snapshot SHA-256: `7bfb9fd243e50fff62145d496aac5c10dc73648e04a8166f998a39e06853dca2`.

## Targeted checks

- `FREE_WORKER_BROWSER=1 python3 tests/free-api-worker/release-postgres.py`: current schema, actual Admin/Seller routes and browser, mocked wallet/provider boundaries.
- `FREE_WORKER_RELEASE_IMPORT=1 python3 tests/free-api-worker/release-postgres.py`: complete retained inventory, two imports, exact Ready IDs, duplicate prevention, stopped state and shared-product preservation.
- TypeScript and affected Seller/provider-auth regressions against the same release tree.

Production verification must not start discovery, remove candidates, create Marketplace products, or request wallet signatures. Authenticated Admin-only checks require an existing authorized owner session; never fabricate one.
