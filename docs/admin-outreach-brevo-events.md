# Admin Outreach Brevo delivery events

Mahshar accepts a deliberately small subset of Brevo transactional-email events at:

`POST https://mahshar.xyz/api/internal/outreach/brevo-events`

The endpoint is disabled unless `BREVO_OUTREACH_WEBHOOK_SECRET` contains 32-256 characters. It uses the Bearer-token authentication supported by Brevo's webhook configuration API. This is a dedicated secret; do not reuse `BREVO_API_KEY` or `OUTREACH_INBOUND_WEBHOOK_SECRET`.

## Contract and mapping

Brevo's transactional payload supplies the internal email ID in `message-id`, the event time in Unix seconds in `ts_event`, and the webhook configuration ID in `id`. The webhook ID is retained as bounded provider metadata but is not treated as a unique delivery-event identifier.

| Brevo payload event | Mahshar event |
| --- | --- |
| `request` | `sent` |
| `delivered` | `delivered` |
| `opened` or `unique_opened` | `opened` |
| `soft_bounce` | `soft_bounce` |
| `hard_bounce` | `hard_bounce` |
| `blocked` | `blocked` |

All other transactional and all marketing events are rejected. Configure a non-batched transactional email webhook so each request is one documented event object. Mahshar matches only a sent Outreach message whose normalized provider message ID and exact recipient agree; it never falls back to subject or fuzzy recipient matching.

Mahshar retains at most one compact row per message/event type. A later occurrence of the same type advances that row; retries and delayed older copies are idempotent. Delivery data never rewrites the Outreach message or thread status.

Official references:

- https://developers.brevo.com/docs/transactional-webhooks
- https://developers.brevo.com/docs/secured-webhooks
- https://developers.brevo.com/reference/create-webhook
- https://developers.brevo.com/docs/retry-mechanism

## Production setup after release audit

1. Generate a distinct token with `openssl rand -hex 32`.
2. Set it as the server-only Vercel Production variable `BREVO_OUTREACH_WEBHOOK_SECRET`, then redeploy the exact audited application release. Never use a `NEXT_PUBLIC_` name.
3. Create one Brevo webhook with `type: "transactional"`, `batched: false`, `channel: "email"`, and the notify URL above.
4. Configure Brevo's webhook `auth` as `{ "type": "bearer", "token": "<same secret>" }`.
5. Subscribe only to `sent`, `delivered`, `uniqueOpened`, `softBounce`, `hardBounce`, and `blocked`. Brevo sends the corresponding payload names shown in the mapping table.
6. Use Brevo's controlled webhook test, if available, with a non-production provider message ID first. Confirm authentication succeeds and the event remains unmatched without changing Outreach state.
7. Send no email solely for testing. After a future approved Outreach send, verify one matched event, repeat the same fixture payload, and confirm the row remains deduplicated.

Brevo documents four retries after the original attempt for unresponsive endpoints and `429` responses, with delays of 10 minutes, 1 hour, 2 hours, and 8 hours. Other `4xx` responses and `5xx` responses stop retries. Mahshar therefore returns terminal `400`/`401` responses for invalid requests and a bounded `429` with `Retry-After: 600` for a transient persistence failure. The endpoint is idempotent across those retries. Raw payloads, headers, email content, API keys, campaign metadata, and webhook secrets are never stored.
