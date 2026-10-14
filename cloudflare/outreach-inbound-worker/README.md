# Outreach inbound Email Worker

This isolated Cloudflare Email Worker forwards every accepted `support@mahshar.xyz` message to the existing verified human mailbox, then submits a bounded normalized copy to Mahshar's existing inbound endpoint. It does not contain or activate an Email Routing rule.

Required encrypted bindings:

- `OUTREACH_FORWARD_TO`: the existing verified human mailbox destination
- `OUTREACH_INBOUND_WEBHOOK_SECRET`: the same server-only value configured in Mahshar Production

The committed `OUTREACH_INBOUND_ENDPOINT` variable is the exact Production endpoint. A separate fixture Worker may override its host with a non-production deployment, but the HTTPS path must remain `/api/internal/outreach/inbound`.

Set both interactively with `npx wrangler secret put <NAME>`. Do not put either value in `wrangler.jsonc`, source, command arguments, or logs. See `docs/admin-outreach-inbound.md` for the staged activation procedure.

## Sender identity boundary

The webhook bearer secret authenticates this bridge, not the author of an email. `message.from` is the SMTP envelope sender; MIME `From`, `Authentication-Results` and ARC headers do not by themselves establish a trusted author identity. The current verified interface provides no proven aligned verdict with guaranteed provenance. Every normalized payload therefore reports `sender_identity_status: unverified`; it never fabricates a pass result.

The pending `20261014000500_admin_outreach_inbound_identity_gate.sql` migration and application guard keep messages unmatched and read-only, including replays of historical matched messages. AI classification, automatic DNC/suppression changes and reply approval/sending are paused. Existing human mailbox forwarding and stored history remain available. Matching envelopes and apparently valid auth headers do not bypass the gate.

This contains the risk but does **not** resolve sender authentication. Restoring automated processing requires a documented receiver-originated, tamper-resistant alignment verdict bound to the exact MIME From and message, verified against this actual routing path. Dashboard authentication results alone do not establish that evidence contract. No live email test or bridge deployment has been performed for this local patch.
