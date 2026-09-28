# Recoverable response retention

Successful paid responses remain recoverable for seven days. The database RPC
`mahshar_prune_api_call_responses(1000)` clears only expired `api_calls.response_body`
values; it does not delete API-call, purchase, delivery, or accounting rows. The
same bounded invocation calls `mahshar_prune_wallet_auth(1000)` to remove expired
or old-used login challenges and expired or old-revoked wallet sessions. It does
not extend active sessions.

`vercel.json` schedules `GET /api/internal/maintenance/prune-responses` once per
day. Set a server-only `CRON_SECRET` of at least 32 random characters in the
Vercel production environment. Vercel Cron sends it as
`Authorization: Bearer <CRON_SECRET>`; the route fails closed if it is absent or
invalid. Do not expose this value through a `NEXT_PUBLIC_` variable.

The schedule is code-configured and takes effect only after deployment to a
Vercel project with Cron available. Operators must verify the deployment's Cron
job and logs after rollout. Non-Vercel deployments must invoke the same protected
route from their scheduler. Failures are returned as non-2xx responses and
logged with the `[response-prune]` prefix.
