# Database bootstrap

The authoritative fresh-install procedure is:

1. Create an empty PostgreSQL database with the Supabase roles `anon`, `authenticated`, and `service_role`.
2. Apply every file in `supabase/migrations/` in parsed migration-version order.

`20240626000000_core_schema_baseline.sql` creates the four original core tables
needed by the historical chain. `supabase/schema.sql` remains a reviewed schema
reference, but it is not applied before migrations. Migration numeric versions
must be unique; historical SQL must never be edited or skipped. New listings
default to inactive and become public only through an explicit verified
activation path.

Run `python3 tests/database/postgres.py` to prove that an empty disposable PostgreSQL cluster reaches the current schema and that the seller-withdrawal reservation serializes concurrent transactions. The test uses PostgreSQL tools from `PATH`, or from `MAHSHAR_PG_BIN` when CI installs them elsewhere. It starts a private socket-only cluster and never connects to Supabase or production.

Recoverable proxy bodies expire after seven days. Retrieval enforces that TTL
even before physical cleanup. The protected scheduled maintenance route invokes
the bounded, service-role-only `mahshar_prune_api_call_responses(1000)` function;
it uses `SKIP LOCKED` and is not executable by public roles. See
[Recoverable response retention](response-retention.md) for deployment and
operational details. Operators may repeat bounded maintenance invocations when
working through a backlog.
