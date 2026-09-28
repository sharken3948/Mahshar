# Database bootstrap

The authoritative fresh-install procedure is:

1. Create an empty PostgreSQL database with the Supabase roles `anon`, `authenticated`, and `service_role`.
2. Apply `supabase/schema.sql` once.
3. Apply every file in `supabase/migrations/` in lexicographic filename order.

`supabase/schema.sql` is the reviewed base snapshot, not a replacement for the migration chain. Historical migrations must never be edited or skipped. New listings default to inactive and become public only through an explicit verified activation path.

Run `python3 tests/database/postgres.py` to prove that an empty disposable PostgreSQL cluster reaches the current schema and that the seller-withdrawal reservation serializes concurrent transactions. The test uses PostgreSQL tools from `PATH`, or from `MAHSHAR_PG_BIN` when CI installs them elsewhere. It starts a private socket-only cluster and never connects to Supabase or production.

Recoverable proxy bodies expire after seven days. Retrieval enforces that TTL even before physical cleanup. A service-role maintenance job should call `mahshar_prune_api_call_responses(1000)` repeatedly until it returns `0`; the function is bounded, uses `SKIP LOCKED`, and is not executable by public roles.
