# Admin Pending Emails

Pending Emails lives at `/admin/operations/pending-emails` under Automation in the
existing Operations shell. The table contains API Name, Email Address and Action.
It uses database pagination, refreshes every 15 seconds while visible and on focus,
and refreshes after confirmed manual actions. Wallet-session Admin authorization,
mutation-origin protection and existing Operations styling remain in place.

This feature has no email transport. Mark as Sent records the authenticated
Admin's declaration that an email was sent externally, not verified delivery.
Contact publication and verified contact readiness do not establish permission
to use an outbound channel.

## Eligibility and permanent ownership

`admin_worker_mail_registry` has one permanent row per provider and canonical
domain, referencing the existing lead and verified contact. States are `pending`,
`manual_sent` and `excluded`. It retains the selected name, address, official
source, verification timestamp, provenance and manual audit fields.

Eligibility requires an active provider, a qualified lead, a non-rejected product,
verified email readiness, an appropriate business contact and current official
identity/contact evidence. Evidence must be within 30 days and cannot be more than
five minutes in the future. Sensitive-purpose inboxes remain ineligible regardless
of older preferred/email-ready metadata. A suitable verified alternative can be
selected without rewriting the existing preferred address. No invitation draft,
Brevo approval or historical shortlist membership is required.

Real sends, reservations, uncertain dispatches, DNC, suppression, finalized states
and permanent manual history block entry. Simulations remain recorded and held
separately as `simulation_history`; they are never described as real delivery.
`draft_invalid`, existing recoverable template/contact skips and draft-only
`provider_failed` attempts with no reservation, dispatch or provider message ID
can recover. Unknown failures remain conservative exclusions. Recoverable
preparation errors never convert a pending claim to permanent exclusion.

Worker evidence/qualification triggers synchronize eligible results in the saving
transaction. Unique constraints, permanent provider identities and reservation
barriers prevent concurrent or cross-product duplicate invitations. Manual marking
stores a permanent timestamp and authenticated Admin wallet, is idempotent, and
neither deletes original data nor creates Outreach messages, receipts or delivery
events. Existing initial delivery reservations cannot compete with manual claims;
existing reply authorization and sending controls are preserved.

## Bounded recovery and retained legacy processing

Before each discovery chunk, `mahshar_worker_mail_recover` verifies the required
migration and checks up to 25 durable providers. A round-robin cursor on
`worker_control` survives run and candidate cleanup. It eventually catches expired
Acquisition investigations and interrupted successful saves without requiring an
attempt/run trigger or a manual database repair.

`mahshar_worker_mail_claim_recovery` allocates at most five contact and five legacy
candidates per logical batch. Internal slots 300–309 leave the existing fresh
0–299 range, checkpoint contract and source/research/Groq/contact limits intact.
Claims replay on Resume. Existing Stop checks apply before further research.
Retained processing does not advance or inflate the fresh-discovery counter.

Contact refresh uses permanent leads, contacts and official sources, including
email-ready leads with stale or inappropriate evidence. It reconstructs temporary
work if candidates were removed. Fresh official documentation is independently
fetched through the existing bounded fetcher and research budget when needed;
contact verification uses the existing contact pipeline. It never reruns Groq for
an already qualified provider or substitutes current timestamps for failed fetches.

Recovery metadata on `worker_leads.mail_refresh` records attempts and backoff.
Failed investigations have at most three attempts per evidence cycle, one hour
apart. Budget pauses do not consume an attempt. Independently changed contact
observations, or a successful verification aging past 30 days, open a new bounded
cycle. Exhausted incomplete investigations need reviewed new evidence; they are
not DNC decisions or permanent mailing exclusions.

The offline historical reconciler produces a `legacyIntake` plan for retained
legacy-only UUIDs. The service-only `mahshar_worker_mail_seed_legacy` RPC defaults
to dry-run. After separate import approval, it can register normalized provider
identities and `worker_providers.mail_intake` assertions with the original legacy
UUIDs, source URLs, asserted documentation/product inputs and CSV hash. Repeated
imports reuse the same identity and do not overwrite existing Worker providers.
It creates no lead, contact, qualification, permission, invitation or mail claim.
Original `discovered_apis` and historical drafts remain untouched.

Normal authorized Worker processing claims those retained inputs without requiring
APIs.guru rediscovery and calls the existing research/qualification/contact
processor. Provider ownership and API compatibility requirements remain intact;
an asserted HTML documentation URL is not itself a verified API contract. Failed
or incomplete research never admits a provider. Successful qualification and
appropriate verified contact evidence trigger ordinary enqueue. Intake assertions,
attempts and backoff remain on the permanent provider after candidate cleanup.
Successful/finalized identities skip expensive rediscovery. Temporary failures
have at most three attempts, with backoff; budget pauses are refunded. Identical
imports never reset attempts. Separately reviewed changed documentation inputs
can reopen incomplete intake through the same seed RPC, preserving the previous
input, hash, attempts and state. Qualified, suppressed, finalized and manual-owned
providers cannot be reopened this way. Dry-run reports the proposed change first.

## Infrastructure and locking

Missing/incompatible required RPCs raise `WorkerMailInfrastructureError` before
source work, budgets or candidate processing. History errors escape directory and
deferred-work catches. They cannot become terminal `source_adapter_unavailable`
records or advance the checkpoint. Admin list and mutation APIs return sanitized
503 errors until the migration is present.

There is no global Admin transaction gate and no statement-level trigger on
operational tables. Cross-channel ownership uses the existing provider row lock.
The two Acquisition claimants now select/lock provider before lead. Entity-editing
Outreach RPCs acquire provider, then thread before message/lead; completion of an
already reserved send uses thread before message and never takes a provider lock.
Stop and inbound/delivery ingestion keep their original bodies and lock paths.

Row-trigger synchronization tries the provider with `SKIP LOCKED`. It never waits
in reverse order while holding a contact/lead/thread row. If busy, the durable
round-robin reconciler retries on a later authorized Worker chunk. Pending queries
and manual marking always recheck current eligibility. The reconciler reads control/run without locking them and synchronizes at most
25 UUID-ordered providers. A separate compare-and-set checkpoint RPC updates the
control cursor only after provider locks commit, while the run is still active.
Losing that checkpoint safely replays the slice; a skipped provider is revisited
after cursor wrap. Cursor and provider locks never coexist in this transaction.

Recovery due clocks (`worker_providers.mail_intake_due_at` and
`worker_leads.mail_refresh_due_at`) are indexed scheduling metadata derived from
saved evidence and durable retry state, never verification or consent. The claim
query reads at most 25 due entries before history checks/row locks and claims at
most five providers per kind/batch. Provider/product/lead locks use `SKIP LOCKED`.
A nonblocking advisory lock only serializes claims for that batch and kind; it
does not lock Stop's control/run rows. Existing candidate foreign keys can take
compatible key-share locks, which do not block Stop's non-key status update.
Evidence writes refresh the clocks. The permanent sweep repairs skipped trigger
work and expired investigations independently of candidate retention. Three-attempt
caps, backoff, reviewed changed-input recovery and replay identity remain intact.
Historical intake has a private nonblocking import lock, and existing-provider
updates use UUID order. It cannot serialize Stop or event processing.

The migration sets transaction-local 5-second lock and 60-second statement limits.
Apply it atomically through migration tracking while scoped processing is quiescent.
Nine new entry RPCs have 250 ms lock and 2 s statement settings. PostgREST hoists
statement settings before execution; direct SQL clients must set the statement
limit before calling. Verify the deployed PostgREST configuration/schema cache
before enabling Worker processing. See the [PostgREST transaction settings](https://postgrest.org/en/stable/references/transactions.html#hoisted-function-settings).
Only six explicitly allowed, idempotent list/manual/recovery RPCs retry confirmed
SQL transaction aborts (`55P03`, `40P01`, `40001`, `57014`): at most three attempts,
with 50/100 ms waits. Unknown HTTP/network outcomes and missing schema escape
unchanged. No Acquisition/Outreach reservation, dispatch or transport RPC is retried.

RLS and service-only RPC access remain enforced. Browser roles cannot invoke the
new functions or write the registry; the service role has no direct registry
write privilege. Dry-runs remain read-only. Initialization fills only the new due
columns from retained facts, before enqueue triggers exist; the registry remains
empty. Applied migrations and original column values remain unchanged.

## Historical reconciliation

```sh
node --import tsx scripts/reconcile-pending-emails.mts
node --import tsx scripts/reconcile-pending-emails.mts --print-query
node --import tsx scripts/reconcile-pending-emails.mts --snapshot /secure/path/snapshot.json
```

The script never connects to a database or imports rows. The CSV is not an
eligibility allowlist: the paginated `mahshar_worker_mail_reconcile` RPC also
audits and backfills eligible Worker providers outside these 50, and normal
Worker recovery sweeps every durable provider. Without a timestamped
read-only snapshot it reports unknown database eligibility. Matching uses
normalized domains and persisted aliases, never names. CSV addresses never replace
verified contacts. The unavailable personalized invitation Markdown is not recreated.

The saved authenticated Production snapshot is from
`2026-10-17T10:19:08.209396Z`, with `transaction_read_only=on`. The corrected policy
was evaluated only in a disposable local replay. Original row values remained
unchanged, and zero registry rows were imported. All 26 legacy intake plans also
passed the service RPC's read-only dry-run validation. The CSV SHA-256 remains
`0db305a6ce0ef944dc7035c0a5f5d3cb3ef8d170db6f8980778983fc98daf6c5`.

| Assessment | Providers |
| --- | ---: |
| Eligible | 17 |
| Qualified; verified contact evidence still required | 1 |
| Qualification incomplete | 4 |
| Legacy first-pass research required | 26 |
| Unresolved durable identity mapping | 1 |
| Historical simulation hold; also review-only qualification | 1 |
| Genuine permanent send/DNC exclusions in this shortlist | 0 |

These counts describe the saved snapshot, not current Production or import
approval. Interzoid, Api2Pdf, Image-Charts, IBANAPI and Shorten.REST now pass the
corrected policy without requiring a prepared draft. SimplyRETS remains a review
candidate. FraudLabs Pro remains review-only and held by simulation history.
Neutrino's `.com` identity still requires a verified persisted alias to its `.net`
Worker identity. Contact readiness remains separate from sending permission.

Complete 50-provider snapshot assessment:

| Provider | Durable domain | Assessment |
| --- | --- | --- |
| Interzoid | `interzoid.com` | Eligible |
| QuickChart | `quickchart.io` | Eligible |
| Api2Pdf | `api2pdf.com` | Eligible |
| OpenCage GmbH | `opencagedata.com` | Eligible |
| Shotstack | `shotstack.io` | Eligible |
| Image-Charts | `image-charts.com` | Eligible |
| Weatherbit | `weatherbit.io` | Eligible |
| SelectPdf | `selectpdf.com` | Eligible |
| PDF Blocks | `pdfblocks.com` | Eligible |
| IBANAPI | `ibanapi.com` | Eligible |
| Word Associations Network | `wordassociations.net` | Eligible |
| Browshot | `browshot.com` | Eligible |
| Shorten.REST | `shorten.rest` | Eligible |
| Deep Art AI | `deeparteffects.com` | Eligible |
| Geneea | `geneea.com` | Eligible |
| RiteKit | `ritekit.com` | Eligible |
| BALLDONTLIE | `balldontlie.io` | Qualification incomplete |
| FraudLabs Pro | `fraudlabspro.com` | Simulation hold; review candidate |
| Neutrino API | `neutrinoapi.com` | Identity mapping unresolved |
| Rev AI | `rev.ai` | Qualified; contact evidence required |
| JSON2Video | `json2video.com` | Legacy first pass required |
| WebScraping.AI | `webscraping.ai` | Legacy first pass required |
| Zenrows | `zenrows.com` | Legacy first pass required |
| ScraperAPI | `scraperapi.com` | Legacy first pass required |
| Uva Software (Scanii) | `scanii.com` | Legacy first pass required |
| GreyNoise | `greynoise.io` | Legacy first pass required |
| FullHunt | `fullhunt.io` | Legacy first pass required |
| what3words | `what3words.com` | Legacy first pass required |
| Filestack | `filestack.com` | Legacy first pass required |
| CraftMyPDF | `craftmypdf.com` | Legacy first pass required |
| JFreaks (IPGeolocation) | `ipgeolocation.io` | Legacy first pass required |
| Scrapingdog | `scrapingdog.com` | Legacy first pass required |
| GNews | `gnews.io` | Legacy first pass required |
| Abstract API | `abstractapi.com` | Legacy first pass required |
| Pulsedive | `pulsedive.com` | Legacy first pass required |
| Detect Language | `detectlanguage.com` | Legacy first pass required |
| OCR.space | `ocr.space` | Legacy first pass required |
| ScrapingAnt | `scrapingant.com` | Legacy first pass required |
| Api2Convert | `api2convert.com` | Legacy first pass required |
| Currents | `currentsapi.services` | Legacy first pass required |
| Lunaweb GmbH (CloudConvert) | `cloudconvert.com` | Legacy first pass required |
| Hunter | `hunter.io` | Legacy first pass required |
| Tomba | `tomba.io` | Legacy first pass required |
| Mailsac | `mailsac.com` | Legacy first pass required |
| Imagga | `imagga.com` | Legacy first pass required |
| Labs64 (NetLicensing) | `netlicensing.io` | Qualification incomplete |
| BulkSMS | `bulksms.com` | Eligible |
| D7 Networks | `d7networks.com` | Qualification incomplete |
| SimplyRETS | `simplyrets.com` | Qualification incomplete |
| Ayrshare | `ayrshare.com` | Legacy first pass required |

## Migration review and release order

Migration `20261017000100` extends the verified 44-migration baseline through
`20261015000600`. None of those applied migration files are edited. It adds the
registry, bounded recovery metadata/internal slots, secure RPCs and Admin-only
provider-level locking. Four selection predicates exclude manual claims or
internal recovery candidates. Two Acquisition claimants and eight Outreach
routines have targeted row-order changes. There is no prefix-based rewrite of all
Admin mutators and no global operational-table gate. Existing privileges, original draft
contents, simulation history, uncertain deliveries, replies and channel controls
remain intact. The migration imports no historical providers or mail rows.

After separate approval:

1. Reconfirm the authenticated target, 44 applied migrations, expected function
   bodies and historical fingerprints. Ensure Worker/Acquisition processing is
   already quiescent; keep real sending disabled. Defer if processing is active.
2. Apply the reviewed migration atomically through migration tracking, then verify
   the ledger, least privilege, function changes and original row values.
3. Deploy the matching isolated application. Verify Admin-only access, list reads,
   infrastructure failure handling and the unchanged Worker command contracts.
4. Obtain a fresh read-only reconciliation snapshot. Review all identities and
   current evidence. Separately authorize bounded `mahshar_worker_mail_reconcile`
   backfill with reviewed provider UUIDs, and `mahshar_worker_mail_seed_legacy`
   intake with the reviewed `legacyIntake` plan. Both RPCs default to dry-run;
   actual application requires `p_dry_run => false`.
5. Verify Production passively before any separately authorized Worker processing.
   Do not test manual marking by falsely declaring a real provider sent.

An application rollback does not remove database guards or manual history. Prefer
roll-forward recovery, retaining the permanent registry and original history.
Observe SQL latency, lock waits, webhook error rates and checkpoint progression
during separately authorized Production verification. Do not remove ownership
barriers or erase registry history to roll back an application deployment.

## Corrective implementation files

- `supabase/migrations/20261017000100_admin_worker_mail_registry.sql`
- `src/lib/admin-worker/contact-coverage.ts`
- `src/lib/admin-worker/discovery/{processor,repository,provider-history,research,types}.ts`
- `src/lib/admin-worker/discovery/mail-recovery.ts`
- `scripts/reconcile-pending-emails.mts`
- `tests/admin/fixture.ts`
- `tests/admin-worker/{mail-list.test.ts,mail-list-postgres.py,contact-coverage.test.ts}`
- This document and local-only `WORKLOG.md`.

The Operations UI, its routes, wallet authorization, email transports and payment,
x402, Gateway and public Marketplace implementation are unchanged by this correction.

## Corrective verification results

- The exact combined isolated source passed 151 individual Node tests: 17 Pending
  Emails/history/recovery cases, 14 contact-coverage cases, 41 Worker/Acquisition/
  Outreach regressions, 76 discovery/contact cases, and three Operations UI cases.
  External research, live inference and transport are forbidden by the fixtures.
- The disposable 44-migration lifecycle/Outreach suite passed, including actual
  TypeScript-to-SQL coordination with mocked Brevo responses. The full 45-migration
  Pending Emails suite passed rollback, original-value preservation, ACL/RLS,
  automatic draft-independent enqueue, history conflicts, provider/product identity
  collisions, actual claim/save lock interleaving, repeated manual marking, expiry,
  stale evidence, candidate cleanup, bounded legacy retries and reviewed-input
  recovery. Actual post-migration Start/Stop/Resume RPCs preserve checkpoints,
  logical batches, budgets and permanent manual history.
- Historical replay reproduced all 50 assessments above, validated all 26 intake
  plans, imported zero registry rows and preserved every original column value.
- Representative performance tests passed the fixed limits described below,
  including actual nested generic plans and a wholly blocked due slice.
- TypeScript passed with no emit/incremental writes. The default `npm run build`
  passed using Turbopack in the isolated archive with independently installed,
  unchanged lockfile dependencies and synthetic build configuration. No production
  credentials were copied. Expected unavailable synthetic catalog reads and the
  existing MCP notification notice are not feature failures. The earlier sandbox
  CSS-worker limitation is resolved by this socket-capable isolated verification.
- Scope checks preserve all 44 applied migrations and all unrelated root work.
  The final correction modifies ten feature/test/documentation files plus the
  local-only work log; the complete combined release contains 29 allowlisted files.

Production migration, application release, historical import and real Worker
processing remain separately authorized steps. No Production migration/import,
sending, Worker launch, flag change, commit, push or deployment was performed.

## Final migration-blocker verification

The combined local release is based on deployed commit
`31eff459f9d2ad0ba7a704ce1d17ba3b95b59dcd`. Authenticated Vercel inspection of
the canonical domain reports Ready; GitHub's successful deployment status joins
that deployment to this exact main commit. The release archive is separate from
the dirty root checkout and has no branch, index, commit or deployment changes.

`/tmp/mahshar-pending-release-manifest.json` records the complete combined allowlist,
SHA-256 hashes, baseline/new file modes, unchanged dependency hashes and scope
verification. `/tmp/mahshar-pending-release.patch` is the matching combined patch.
New files and existing normal source files use Git mode `100644`. The deployed
PostgreSQL baseline runner `tests/admin-worker/postgres.py` retains its original
`100755` mode. Every other deployed file and executable/symlink mode is preserved.
The README overlay retains the deployed Acquisition documentation and adds only
the Pending Emails paragraph; it intentionally excludes the root's older unrelated
README changes. The original CSV and private database snapshots/reconciliation
reports are separate review inputs, not application-release files. Historical
verification accepts `--historical-csv /secure/path/shortlist.csv` explicitly.

The complete combined release allowlist is:

```text
README.md
docs/admin-pending-emails.md
scripts/reconcile-pending-emails.mts
src/app/admin/operations/operations-shell.tsx
src/app/admin/operations/pending-emails/page.tsx
src/app/admin/operations/pending-emails/pending-emails-client.tsx
src/app/api/admin/worker/mail-list/[id]/mark-sent/route.ts
src/app/api/admin/worker/mail-list/route.ts
src/lib/admin-worker/contact-coverage.ts
src/lib/admin-worker/discovery/mail-recovery.ts
src/lib/admin-worker/discovery/processor.ts
src/lib/admin-worker/discovery/provider-history.ts
src/lib/admin-worker/discovery/registry.ts
src/lib/admin-worker/discovery/repository.ts
src/lib/admin-worker/discovery/research.ts
src/lib/admin-worker/discovery/types.ts
src/lib/admin-worker/mail-list-repository.ts
src/lib/admin-worker/mail-list-rpc.ts
src/lib/admin-worker/mail-list-types.ts
supabase/migrations/20261017000100_admin_worker_mail_registry.sql
tests/admin-worker/contact-coverage.test.ts
tests/admin-worker/mail-list-performance.py
tests/admin-worker/mail-list-postgres.py
tests/admin-worker/mail-list-register.mjs
tests/admin-worker/mail-list-ui-register.mjs
tests/admin-worker/mail-list-ui.test.ts
tests/admin-worker/mail-list.test.ts
tests/admin-worker/postgres.py
tests/admin/fixture.ts
```

Representative PostgreSQL verification uses 10,000 providers, 20,000 products,
leads, contacts and sources, 1,000 Acquisition attempts, 1,000 Outreach threads
and messages, and 754 retained legacy records; 50 additional synthetic legacy
assertions test first-pass scheduling. All data is disposable. Timings include
local `psql` process/connection startup. They are not Production latency forecasts.
Acceptance criteria were fixed before measurement: Stop/inbound/delivery below
250 ms while recovery remains open, ordinary claims below 500 ms, at most 25 due
entries scanned and five provider locks, and verified 250 ms lock / 2 s statement
cancellation without history loss.

| Operation | Baseline median / max (ms) | Corrected median / max (ms) | While claim held (ms) | While sweep held (ms) |
| --- | --- | --- | --- | --- |
| Worker Stop | 18.06 / 158.99 | 16.93 / 21.18 | 30.3 | 23.93 |
| Delivery ingestion | 18.95 / 23.07 | 17.88 / 22.7 | 29.78 | 26.24 |
| Inbound ingestion | 19.5 / 24.24 | 16.34 / 18.79 | 27.56 | 23.42 |

Normal retry/recovery claim: 106.18 ms; profiled generic contact/legacy claims: 108.83 / 98.9 ms. Busy-provider skipping: 110.61 ms. Confirmed lock cancellation: 269.65 ms; statement cancellation: 2026.21 ms. The blocked slice holds exactly 5 provider locks and spends no attempts. Initial due-clock migration work took 30.87 seconds on this deliberately enlarged dataset; this is a quiescent-window DDL operation, not a runtime claim.

Both contact and legacy due queries use their scheduling indexes. The actual
nested claimant plans use `force_generic_plan` and are captured with `auto_explain`, not inferred only from a
standalone EXPLAIN. `pgrowlocks` measures actual provider/product/lead locks and
compatible run key-share locks; there is no control-row lock during recovery.
Stop and both event handlers finish while the recovery transaction is deliberately
held for 1.8 seconds. The harness also checks a wholly blocked due slice, rollback,
retry caps, absent temporary candidates and separate checkpoint replay.

The focused SQL suite exercises actual Acquisition claim versus qualification
persistence, verifies provider and lead locks at the claim's INSERT barrier,
then verifies that qualification waits on the provider. It also races initial
Outreach reservation versus enqueue, manual marking versus enqueue, repeated
marks and interrupted transactions. The original 44-migration lifecycle suite
covers existing Worker/Outreach behavior and mocked, never live, Brevo operations.

Reproduction on the isolated archive (PostgreSQL binaries/contrib must be available):

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --import tsx --require ./tests/admin-worker/mail-list-register.mjs --test tests/admin-worker/mail-list.test.ts tests/admin-worker/contact-coverage.test.ts
python3 tests/admin-worker/mail-list-postgres.py
python3 tests/admin-worker/mail-list-performance.py
python3 tests/admin-worker/postgres.py
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Use a socket-capable local environment. File-level Node test passes without the
expected individual case count are not verification evidence. Production keeps
its existing Node 24 runtime; local Node 20 dependency engine notices do not
justify changing dependencies or deployment settings.

The migration's due-clock initialization preserves every original column and
creates zero registry/import rows. It still needs a quiescent migration window
and bounded DDL lock/statement limits. Apply migration, verify catalog/ACL/history,
deploy the exact reviewed application, verify passive routes, then obtain fresh
historical dry-runs and separate authorization for any backfill/intake/Worker run.
If deployment is postponed or rolled back, keep the additive schema, guards and
permanent history; keep processing and delivery stopped/disabled. Prefer a reviewed
forward correction. Do not drop history or repair the ledger manually.
