# Outreach inbound Email Worker

This isolated Cloudflare Email Worker forwards every accepted `support@mahshar.xyz` message to the existing verified human mailbox, then submits a bounded normalized copy to Mahshar's existing inbound endpoint. It does not contain or activate an Email Routing rule.

Required encrypted bindings:

- `OUTREACH_FORWARD_TO`: the existing verified human mailbox destination
- `OUTREACH_INBOUND_WEBHOOK_SECRET`: the same server-only value configured in Mahshar Production

The committed `OUTREACH_INBOUND_ENDPOINT` variable is the exact Production endpoint. A separate fixture Worker may override its host with a non-production deployment, but the HTTPS path must remain `/api/internal/outreach/inbound`.

Set both interactively with `npx wrangler secret put <NAME>`. Do not put either value in `wrangler.jsonc`, source, command arguments, or logs. See `docs/admin-outreach-inbound.md` for the staged activation procedure.
