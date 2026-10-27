# Free API Worker Admin — Phase 1

The existing `/admin/free-api-worker` page reads the Worker database through the authenticated Admin status route. It never reads local validation JSON at request time and never writes Marketplace products.

## Inventory and local activation

Source: `isolated-validation/free-api-worker-replacement/inventory-completion/`.
The frozen inventory contains 3,633 evaluations, represented by 3,619 database identities and 14 merged aliases. Its 656 Ready to List candidates retain their original endpoints, source links, successful test timestamps and commercial evidence. Original records, history, alias records and final checks are retained in `saved_inventory`; source documents remain in the unchanged inventory directory.

Apply the repository migration chain to an isolated local Supabase instance through the existing migration workflow. The additive migration is `20261027184622_free_api_worker_admin_phase1.sql`. The earlier replacement migration has dependency guards and must be reviewed separately before any future deployment. This phase does not apply either migration to Production.

Import with the local instance's URL and service key already set in these environment variables:

```sh
node --import tsx scripts/free-api-worker-import.mts --local
```

Required variables: `FREE_WORKER_LOCAL_SUPABASE_URL` (HTTP localhost only) and `FREE_WORKER_LOCAL_SERVICE_KEY`. The command does not load application `.env` files. It validates the saved manifest and imports atomic batches of 50. Rerunning resumes an interrupted import without overwriting newer results or removals. Configure the existing local application against that same isolated database and use the existing Admin wallet session. Do not point the application or importer at Production.

## Controls and removal

- Start and Resume process only unfinished stored records, with three concurrent candidates and 50 per Workflow step. The existing durable workflow automatically continues between batches. There is no discovery in this runtime and no daily quota.
- All frozen evaluations are already completed, including unsuccessful/NOT VERIFIED evaluations. Importing them does not silently schedule fresh tests. An empty unfinished queue completes without outbound requests.
- Stop prevents subsequent claims. In-flight candidates finish safely. A successful functional test is checkpointed before terms research, so terms-only recovery does not repeat it. Each completed candidate is saved immediately; documents are released after each batch.
- Resume is available after in-flight claims drain. After a process crash, an orphan claim can be reclaimed after its 15-minute lease expires; stale tokens cannot overwrite a reclaimed result. External Retry-After pauses and one attempt per run prevent an infinite retry loop. Future paused work remains saved for Resume.
- Checkboxes select the current filtered page. Removal requires confirmation and the existing owner session. It creates persistent Worker-only tombstones, suppresses endpoint aliases and retains evidence. Reimport/admission cannot restore removed identities.
- Ready to List indicates technical preparation for the owner's decision, not paid resale permission. The main table omits permission classifications; saved findings remain in Details and the evidence view. Bulk List is disabled in Phase 1. No publication endpoint or transaction flow was added.

## Reproducible isolated verification

```sh
node --import tsx tests/free-api-worker/worker.test.ts
FREE_WORKER_PHASE1=1 FREE_WORKER_BROWSER=1 python3 tests/free-api-worker/postgres.py
```

The integration harness creates a disposable PostgreSQL cluster with no TCP listener, applies the migration chain, imports the actual inventory, and exercises the actual Admin route handlers, workflow loop and React UI. Synthetic unfinished APIs test controls without calling external services. The browser harness substitutes only its isolated wallet session and Workflow dispatch boundary; it is not a Production wallet authorization or hosted Workflow deployment test. A locally installed PostgreSQL 16 distribution and cached Playwright/Chromium are required. `MAHSHAR_PG_BIN` can select the PostgreSQL binary directory. If Chromium libraries are unpacked locally instead of installed system-wide, set `FREE_WORKER_BROWSER_LIBRARY_PATH` to their library directory; this is passed only to the test browser.

Evidence is written only under `isolated-validation/free-api-worker-replacement/admin-phase1/`; the source inventory is not changed. Temporary records and the database are removed after verification. Production activation and hosted Workflow execution remain outside Phase 1.

## Phase 2 extension

After applying `20261027193455_free_api_worker_discovery_sources.sql` to the isolated local database, Start also discovers from the four original catalogues plus Mixed Analytics, MET Norway official product documentation, n0shake/Public-APIs and APIs.guru. Resume retains both the source cursor and unfinished validation work. Candidate admission and processing use batches of 50; saved identities include original aliases, exclusions and manual removals. A finished source pass sleeps for one hour through the existing Workflow before checking for updates. This is polling backoff, not a daily quota. Provider Retry-After remains authoritative.

Run the isolated Phase 2 fixture test with `FREE_WORKER_PHASE2=fixtures python3 tests/free-api-worker/postgres.py`. `FREE_WORKER_PHASE2=live` runs controlled real-source requests, saves a checkpoint after each batch and resumes that checkpoint when rerun. The live test stops after exercising all four independent adapters with new candidates; it does not exhaust every API in the directories. Runtime discovery has no corresponding test stop condition. Evidence and authenticated Admin output are under `isolated-validation/free-api-worker-replacement/discovery-phase2/`. These are isolated verification results, not Production records.

After a real run, `node --import tsx tests/free-api-worker/verify-real-evidence.ts` checks the new Ready responses against their exact saved public evidence without network requests. It also verifies all 656 original Ready records and agreement between database evaluation output, the authenticated Admin list and the report. The disposable verification database is removed after the run; saved artifacts and checkpoints remain local.
