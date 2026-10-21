# Controlled infrastructure-protection release

Canonical base: `e77788a7f4342b2e4d23a7b384be38dab13f5759`. Work remains local in the existing isolated candidate. This is the current release procedure; the previous review's CSS gate is superseded by the user's instruction to document that unchanged baseline failure. HTML/WAF work is outside this release. No runtime code was changed during finalization.

## Release state and approvals

The application candidate and offline compatibility evidence are ready. **Actual Production recovery readiness is not yet verified**: a management login does not establish the correct database binding, a usable backup, or successful restoration. `release-readiness.json` records unverified gates as false, not as assertions that the owner has no backup. Synthetic recovery evidence cannot clear the Production gate.

Required approvals are specific:

1. Read-only Production binding/ledger checks and a bounded logical backup into owner-controlled encrypted storage; restore that archive only into an approved isolated environment. No database-password reset, paid project, PITR upgrade or new backup service is authorized.
2. Local release branch/staging/commit of exactly the manifest, excluding `WORKLOG.md`, dirty-workspace files and generated output. No commit is made now.
3. Only migration `20261021000100_resource_cost_protection.sql`, new ledger entry through the existing approved runner, and the separate concurrent index on the verified project.
4. Publish/deploy the reviewed application after database readiness. A push to a Vercel-connected Production branch may itself deploy: treat that push as the deployment boundary and obtain approval before it. Never push first and seek deployment approval afterward.

Do not activate budgets or alter unrelated provider settings as part of these approvals. Recheck that Production still uses the canonical base before each state-changing step; stop on drift, do not merge/rebase/repair automatically.

## Initial resource-budget configuration

The exact intended profile is `initial-budget-profile.env`: all four new enable flags are `false` (absence is also disabled). Verify those non-secret values in the actual target deployment configuration before approval. The file is a review artifact, not an applied Vercel setting. Do not import test environment variables or whole `.env` files.

No new numeric ceiling is approved. Groq, listing creation, verification and Onramp policy engines passed enabled/disabled tests, but **none is ready for live enforcement without calibration and separate activation approval**. Keep original SDK token behavior, existing application rate limits and financial controls. Old example limits exist only in synthetic test fixtures. Enablement later requires every positive ceiling, model/output capacity, aggregate request/unit/concurrency headroom and mixed Buyer/Seller/Worker/agent workload tests. It is not part of this release.

Meaningful initial benefits and overhead:

| Change | Benefit | Incremental runtime work |
|---|---|---|
| Local indexed MCP lookup | Removes self-HTTP and up to 101 discovery pages per lookup | One indexed listing query plus its existing stats RPC; no extra function invocation for internal discovery |
| Bounded public catalog SQL | Bounds public response rows and optional pagination | No extra query; owner listing scope preserved |
| New optional budgets, disabled | Prepared global controls independent of IP/wallet rotation, without normal-usage disruption | Zero budget RPCs; canonical Groq parameters |
| Operational retention | Bounded cleanup of expired rate-limit/cost records, without deleting business/financial history | 1–5 extra RPCs only in the existing authenticated daily maintenance path; 2.5-second total deadline; at most 1,000 rows/table/batch |
| Concurrent retention index | Makes expiry cleanup bounded without a full-table expiry scan | One additional narrow B-tree index to maintain on new rate-limit buckets; storage/WAL overhead, no new network round trip |
| Prepared pre/postflight and health SQL | Release checks and manual visibility | No automatic schedule or public request overhead |

Public listing caches/CDN TTLs and uncalibrated mutation/Onramp gates were removed. Current listing state and prices are read fresh; existing sitemap revalidation remains unchanged. No financial state, signature, authorization, withdrawal, settlement, nonce or recovery logic changes.

## Gate 1 — Real encrypted backup and isolated restore

Use an existing owner-approved backup if its database binding, snapshot scope, encryption and successful isolated restore are verified. Otherwise obtain a bounded logical export in the release window. Check the current server/client versions and source role permissions first. Use direct or session-mode connectivity, not transaction pooling. Do not assume an account management token is a database connection, and do not reset credentials to make the procedure work.

Follow the installed, approved Supabase CLI's [backup/restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore). Its handling of managed schemas differs from a plain PostgreSQL dump. The logical export needs application schemas/data/roles and an explicit migration-history export; inventory any Auth, Storage, extension, Vault/encryption or other recovery dependencies. Database backups do not include Storage object bytes; see [Supabase backup scope](https://supabase.com/docs/guides/platform/backups). This release does not justify creating a paid clone or upgrading the plan.

Example commands are for an approved operator in an independently verified CLI context, **not for execution by this local preparation task**. Use a preconfigured CLI context with existing database credentials. If a tool needs to create a CLI database role or change authentication privileges, stop; that is outside read-only backup approval. Use a protected encrypted scratch volume, `umask 077`, an owner-managed credential store, and pinned recovery-key fingerprint. Do not put passwords, database URLs containing credentials, private keys or backup contents into Git, chat, logs or shell history.

```sh
supabase db dump --linked --role-only --file "$MAHSHAR_BACKUP_SCRATCH/roles.sql"
supabase db dump --linked --file "$MAHSHAR_BACKUP_SCRATCH/schema.sql"
supabase db dump --linked --data-only --use-copy --file "$MAHSHAR_BACKUP_SCRATCH/data.sql"
supabase db dump --linked --schema supabase_migrations --file "$MAHSHAR_BACKUP_SCRATCH/history-schema.sql"
supabase db dump --linked --schema supabase_migrations --data-only --use-copy --file "$MAHSHAR_BACKUP_SCRATCH/history-data.sql"
tar -cf "$MAHSHAR_BACKUP_SCRATCH/backup.tar" -C "$MAHSHAR_BACKUP_SCRATCH" roles.sql schema.sql data.sql history-schema.sql history-data.sql
gpg --recipient "$MAHSHAR_RECOVERY_PUBLIC_FINGERPRINT" --output "$MAHSHAR_BACKUP_DEST/backup.tar.gpg" --encrypt "$MAHSHAR_BACKUP_SCRATCH/backup.tar"
sha256sum "$MAHSHAR_BACKUP_DEST/backup.tar.gpg"
```

Before exporting, verify the CLI context is the actual Production project, the destination exists with restricted access/capacity, and the recipient fingerprint is correct. Do not use `--trust-model always` for an unverified operator key. Inspect export scope with the approved CLI/version; do not silently ignore errors or remove grants/functions to get a restore to pass. The data export must capture all financial tables in one consistent snapshot, with schema changes excluded during export. Migration history is exported separately while the ledger remains unchanged.

Restore only into an empty, isolated Supabase-compatible environment with matching roles/extensions, external network access denied and no active cron/Worker/email/webhook execution. Do not point applications or provider credentials at it. Decrypt with the owner's recovery key and verify the archive checksum. Use the provider's role/schema/data/history order and a single transaction with `ON_ERROR_STOP`; import data with session-local replication mode only where that procedure requires it. Never use `--clean` against a live database. The same archive must supply expected counts/fingerprints; later live Production counts are not the same snapshot.

Verify application tables/data, migration ledger (52 versions), function definitions/owners/effective ACLs, table RLS/policies, constraints/indexes, nonces, pending/unknown settlement and withdrawal states, purchase identities and private response-recovery fields. Confirm operator access to the matching application encryption key and existing secret recovery process without collecting any secret here. Run only offline/mock compatibility checks, no financial execution or provider probes. The real receipt should privately record source-project binding, deployment/base, snapshot timestamps, included/excluded resources, encrypted archive checksum/location, recoverable key reference, isolated restore target/version, results and elapsed time. Do not copy the archive or financial fingerprints into this repository.

The local `recovery-rehearsal.py` tests encryption/decryption, corruption rejection, full application data/metadata restoration, the 52-version ledger, migration/index sequence and cleanup preservation using synthetic data on plain PostgreSQL. Its temporary keyring is destroyed; only non-sensitive test results are retained. It is **not** proof that a real Supabase Production archive, managed schemas, provider settings or keys are recoverable.

## Gate 2 — Database release, before any Production Git push/deployment

1. Verify baseline deployment/rollback ID, correct Supabase project and backup receipt. Confirm connection, I/O, disk/temp-space and quota headroom for the backup and concurrent index; no paid quota increase is assumed. Run read-only `scripts/infrastructure/migration-preflight.sql` through the secure verified database connection. Require `ready_to_apply=true`: exact 52 historical versions, no unexpected/missing versions, no partial new objects/index. A missing ledger, unexpected version or conflicting object is a STOP; never repair/replay history automatically.
2. Use the approved migration runner's dry run to require **only** the new migration. For a linked approved Supabase CLI context, this is `supabase db push --linked --dry-run`; if it proposes any historical migration, stop. After explicit approval, the corresponding migration command is `supabase db push --linked`, recording only the new version. Confirm the selected runner's transaction handling; the new migration is transactional. Do not use `--include-all` or migration-history repair as a shortcut. If the existing project uses another runner, verify its equivalent single-migration/ledger behavior before approval.
3. Run `scripts/infrastructure/rate-limit-retention-index.sql` using `psql -X -v ON_ERROR_STOP=1 -f ...` on that verified connection, **without** `--single-transaction` or an enclosing transaction. It creates the retention index concurrently. Verify valid/ready, correct table, non-partial single `bucket_start` key. A failed build can leave an invalid index: stop and separately approve removal of only that invalid new index before retrying. `IF NOT EXISTS` does not repair it.
4. Run read-only `scripts/infrastructure/migration-postflight.sql`; require `ready_for_application=true`: ledger 53, correct operational RLS/grants, service-only RPCs and exact valid index. Preserve private before/after schema evidence for existing financial objects. No budget reservation, prune RPC, payment, listing or Worker action is needed for this check.

The old application remains compatible between these steps: the schema is additive. A migration lock/statement timeout aborts; reschedule, do not expand timeouts or retry indefinitely. If database preparation succeeds but deployment is postponed, leave the harmless operational additions dormant.

## Gate 3 — Publish/deploy and verify

After separate approval, publish exactly the reviewed manifest from the canonical base, with no Canary history/files, old remediation patches, `WORKLOG.md`, `.next`, test credentials/font fixtures or `NODE_OPTIONS` in deployment configuration. Record the actual release commit and deployment ID; pre-commit integrity checks require canonical HEAD/empty index, so after an approved commit verify its parent/base and manifest hashes instead of pretending HEAD is still the baseline. Verify Git integration routing before a push that might auto-deploy.

Deploy with all new budgets disabled. Observe or use separately approved low-volume read-only public catalog/discovery reads and MCP initialize/tools-list interactions. Check current listing visibility, owner reads with an existing authorized session, and normal Buyer/Seller/Admin operations. Watch existing normal x402/Gateway/withdrawal/recovery traffic and errors; no synthetic payments, AI inference, listings, emails, wallet creation, Worker start or extra blockchain/provider calls are authorized. Do not manually invoke the pruning endpoint to test it. Observe its next existing authenticated scheduled execution and logs.

Compare function duration/error rate, database pressure and routine responses with the pre-release baseline. No new budget 429/503 should occur with flags disabled. On new failures, lost listing visibility, unexpected resource growth or financial/recovery errors, roll back immediately and investigate using existing evidence. The baseline CSS failure remains documented; do not suppress assertions or change UI as part of this release.

## Rollback and recovery distinction

Immediate rollback is the recorded canonical baseline application deployment. Restore its recorded environment if any approved release-specific setting changed. Keep the additive operational tables/functions/index and all financial records; old code ignores them. No new budget flag should be active. Do not delete counters, alter nonces, disable authorization or roll back financial migrations.

A database backup restore is **not** the normal deployment rollback. Restoring an earlier snapshot over a running financial system can discard newer settlements, purchases and replay records. Disaster recovery needs separate incident approval, writer isolation, preservation of newer evidence and reconciliation using existing recovery/accounting procedures; never reset chain/payment state to match a stale snapshot automatically.

All actual commit/push, backup access, restore target provisioning, Production migration/index work and deployment remain approval-bound. No live resource-budget activation or provider configuration is included.
