# Mahshar V2 autonomous-agent integration

Start at `GET https://mahshar.xyz/api/agent/discover`. The response links
`https://mahshar.xyz/api/openapi`; no source-code knowledge or browser is
required. Never derive or guess a seller endpoint—the public interface does not
expose it.

Use the discovery `limit` (1–100) and `offset` parameters and follow
`pagination.next_offset` until it is null.

Before signing, compare the challenge `payTo` with discovery's
`payment_recipient`, and compare the challenge EIP-712 name, version, and
verifying contract with discovery's `payment_domain`. Reject any mismatch.

## Selecting and constructing a call

Each listing declares `method`, `proxy_url`, `proxy_style`, `request`, `response`,
price, auth type, and optional JSON schemas/parameter declarations. A `path`
listing is called with its configured GET or POST method. An `envelope` listing
is called with outer POST and JSON `{api_id,buyer_wallet,method,path?,body?}`.
GET never forwards a body. POST, PUT, and DELETE accept JSON bodies; DELETE may
omit it. Buyer-supplied headers are intentionally not forwarded. Seller auth is
injected server-side.

## x402 v2 and Arc Mainnet

1. Send the exact intended request without `Payment-Signature`.
2. Expect HTTP 402, body `{}`, and base64 JSON in `PAYMENT-REQUIRED`.
3. Validate `x402Version=2`, `scheme=exact`, `network=eip155:5042`, the Arc USDC
   asset, amount, payTo, timeout, and Gateway EIP-712 domain.
4. Sign `TransferWithAuthorization` with a unique bytes32 nonce and the installed
   Circle batching client's required validity window.
5. Retry the byte-identical URL/body with the base64 x402 v2 payload in
   `Payment-Signature`.

The installed Circle `GatewayClient` requires `chain: 'arc'` and an explicit
`rpcUrl`. The facilitator path retains `arcPrivateMainnet` and the
`X-ARC-PRIVATE-MAINNET-ENABLED` behavior required by the installed SDK.

Every accounted response carries base64 x402 v2 `PAYMENT-RESPONSE`, independently
of the upstream HTTP result. The JSON body declares settlement and delivery:

```json
{
  "response": {},
  "latency_ms": 42,
  "payment": "ACCOUNTING_COMPLETE",
  "delivery_state": "SUCCEEDED",
  "retryable": false,
  "attemptId": "...",
  "purchase_access_token": "..."
}
```

`FAILED_RETRYABLE` means Mahshar proved no upstream dispatch occurred and the
same proof plus exact request may be replayed. `FAILED_FINAL` means an upstream
response was received and the request will not run again. `UNKNOWN` means a
timeout/crash/transport boundary made the side effect unknowable, so automatic
re-execution is forbidden. `IN_PROGRESS` is a short-lived delivery lease.
Never create a new authorization merely because delivery did not succeed.

## Purchased-response access and recovery

Persist `purchase_access_token` scoped by normalized wallet and API ID. Retrieve
the private response for that exact purchase from
`GET /api/calls/last-response?api_id=...&buyer_wallet=...` with
`x-mahshar-purchase-access`. A browser with a valid owner wallet session may
exchange a legacy purchase without a capability; ownership is checked against
the purchase row before issuing the capability.

`POST /api/payments/reconcile` requires the payer's wallet session and an exact
`{ "attemptId": "..." }` body. It can finish durable accounting only. It
does not settle again, refund, or execute upstream.

## Limits and errors

Discovery is limited to 120/minute, AI matching to 20/minute, unpaid probes to
120/minute per API/client dimension, and expensive payment verification to
60/minute per API/client dimension. HTTP 429 returns `error=rate_limited`,
`retry_after_seconds`, and `Retry-After`.

On Vercel, only Vercel's owned client-IP header is trusted. Other deployments
must set server-only `MAHSHAR_TRUSTED_CLIENT_IP_HEADER` to a header that their
edge proxy overwrites (`x-forwarded-for`, `x-real-ip`, or `cf-connecting-ip`).
Without a trusted edge identity Mahshar uses a higher, shared global fallback
bucket instead of trusting caller-supplied forwarding headers.

Upstream redirects are rejected. Final serialized response wrappers over 4,000,000 bytes return HTTP 502.
Upstream JSON is returned as JSON; text and malformed JSON are returned as a
string inside the wrapper. Upstream 4xx/5xx status is preserved. Inspect
`delivery_state` before deciding whether any replay is allowed.

## Deliberate live harness

Dry run (discovery and OpenAPI only; signs and pays nothing):

```bash
npx tsx scripts/mahshar-agent-e2e.mts
```

Live execution must be deliberate. Supply the key through the local environment;
never put it in a command argument, file, log, or prompt:

```bash
MAHSHAR_AGENT_E2E_LIVE=true \
MAHSHAR_BASE_URL=https://mahshar.xyz \
MAHSHAR_AGENT_E2E_MAX_LISTING_USDC=0.001 \
MAHSHAR_AGENT_E2E_PRIVATE_KEY="$LOCAL_TEST_SIGNER_KEY" \
npx tsx scripts/mahshar-agent-e2e.mts
```

The wallet must already have Arc Mainnet Gateway USDC. The catalog must contain
one qualifying GET/path listing, one envelope listing, and one envelope listing
declaring the controlled `mode=server-error` path. The harness stores only
purchase capabilities in `.mahshar-agent-capabilities.json` with mode 0600; the
file is gitignored. It never prints the key, payment signature, or capability.
