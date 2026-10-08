# Admin Outreach inbound mailbox bridge

Mahshar's application does not currently receive mail directly. Public MX records for `mahshar.xyz` point to Cloudflare Email Routing, while Outreach delivery uses Brevo only for outbound transactional email. The Brevo account had no inbound or transactional webhooks configured when Outreach V2 was implemented. The private Cloudflare forwarding destination is not visible from repository configuration or public DNS.

Outreach V2 therefore exposes a normalized mailbox-bridge endpoint rather than claiming direct Brevo inbound support:

`POST /api/internal/outreach/inbound`

The endpoint is inactive until the server-only `OUTREACH_INBOUND_WEBHOOK_SECRET` is configured. The bridge must send `Authorization: Bearer <secret>` and `Content-Type: application/json`. Use a distinct random secret of at least 32 characters in production.

```json
{
  "message_id": "<unique inbound Message-ID>",
  "in_reply_to": "<outbound Message-ID or provider message ID>",
  "references": ["<bounded reference ID>"],
  "sender_email": "provider@example.com",
  "recipient_email": "support@mahshar.xyz",
  "subject": "Re: Example API on Mahshar",
  "text": "Plain-text reply without quoted mailbox history.",
  "received_at": "2026-10-08T10:00:00.000Z"
}
```

The bridge must run inside the trusted mailbox path—for example, a Cloudflare Email Worker attached to the existing Email Routing rule, or a controlled bridge at the current forwarding mailbox. It must derive fields from the received message, strip quoted history/signatures where practical, omit attachments and raw MIME, and never accept browser-submitted values. The application rejects requests without the shared secret, payloads over 64 KiB, recipients other than `support@mahshar.xyz`, malformed addresses/identifiers, empty text, and excessive references.

No bridge is created or activated by the code migration. A minimal production setup is:

1. Generate a dedicated 32-byte secret, for example with `openssl rand -hex 32`, and store it in the deployment secret manager. Do not put it in the repository, browser code, logs, or a shell-history-bearing command line.
2. Run `vercel env add OUTREACH_INBOUND_WEBHOOK_SECRET production` from the linked project and paste the value at the prompt. Adding a Vercel environment variable does not change an existing deployment; do not redeploy yet.
3. Apply the Outreach V2 migration. Do not deploy the V2 application code or point real mail at it while this migration is pending.
4. Deploy the reviewed release through the normal Git/Vercel production workflow or explicitly redeploy it, then confirm the deployment is READY and assigned to `mahshar.xyz`.
5. From `cloudflare/outreach-inbound-worker`, install the locked dependencies with `npm ci`, then inspect the bundle with `npx wrangler deploy --dry-run`. Create the Worker with `npx wrangler deploy` while it remains unattached; the committed Wrangler configuration deliberately declares no Email Routing address or HTTP route.
6. Store the existing verified mailbox destination with `npx wrangler secret put OUTREACH_FORWARD_TO`, and store the same server-only inbound value with `npx wrangler secret put OUTREACH_INBOUND_WEBHOOK_SECRET`. Both commands prompt interactively; never embed either value in source, configuration, command arguments, or logs. Redeploy while the Worker remains unattached. The Worker calls `message.forward(OUTREACH_FORWARD_TO)` before the normalized Mahshar POST, so a Mahshar configuration, parse, or webhook failure cannot suppress successful human delivery.
7. Parse the message as MIME inside the trusted bridge, submit only bounded plain text, omit attachments and raw MIME, and POST the normalized JSON contract above to `https://mahshar.xyz/api/internal/outreach/inbound` with `Authorization: Bearer <secret>` and `Content-Type: application/json`. Parse `Message-ID`, `In-Reply-To`, and `References` into their individual bounded identifiers; use the single validated RFC From address for `sender_email`.
8. Before accepting real replies, deploy a separate fixture Worker and attach it only to a non-production fixture address/routing rule. If a non-production Mahshar deployment and database are available, override that Worker's `OUTREACH_INBOUND_ENDPOINT` host while retaining the exact `/api/internal/outreach/inbound` path; never point a fixture delivery at Production. Verify that the human mailbox receives the forwarded message, the bridge receives a success response, exactly one inbound record is stored, the intended thread is matched, and any suggested reply remains an unsent draft. Repeat the same fixture delivery once and confirm the stable `Message-ID` is deduplicated.
9. Only after the controlled checks pass, change the existing `support@mahshar.xyz` Email Routing action from direct forwarding to the audited Worker. The resulting path is `support@mahshar.xyz` → Email Worker → existing verified human mailbox plus normalized Mahshar POST. Do not change the main-domain MX records.

Brevo inbound parsing is an alternative only after a separate receiving subdomain is delegated to Brevo and outbound messages deliberately use that address as their reply target. That is not the current `support@mahshar.xyz` routing model and is not enabled by Outreach V2.

Delivery-event webhooks are not included. They require a separately authenticated Brevo transactional webhook and their own bounded event-state policy.
