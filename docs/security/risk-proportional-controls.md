# Risk-proportional controls

## Listing edits

An eight-hour wallet session is sufficient for presentation and ordinary
management fields: name, description, category, price, examples, documentation,
request/response schemas, expected application status codes, body requirements,
and activation state.

Changes that can redirect or broaden credential forwarding require both the
owner session and a fresh five-minute, one-use EIP-712 operation authorization.
The signed payload binds the wallet, HTTP method, exact listing route, listing
ID through that route, and canonical hash of the complete PATCH body. The
sensitive fields are `endpoint_url`, `auth_type`, `auth_key` (stored as
`encrypted_key`), `auth_param_name`, `method`, `dynamic_path_supported`,
`path_parameters`, and `query_parameters`.

## Retry policy

Automatic retry is allowed for reads and deterministic operations designed to
be idempotent. The wallet-session client may repeat a request only after the
server explicitly rejects it before handler execution with a missing or expired
session. Fresh one-use listing authorizations are never automatically replayed.

Mahshar never automatically resubmits x402 delivery in `UNKNOWN`, an ambiguous
Gateway withdrawal transfer, an ambiguous Arc mint, or another irreversible
external action without a proven idempotency mechanism. Durable state remains
locked and users receive a status/reconciliation action instead.

## Rate-limit availability policy

- Fail closed: wallet login challenge/verification, paid proxy ingress/payment,
  seller credential-sensitive listing verification, Groq score/match, and
  money-moving routes that use a limiter.
- Fail open with structured error logging: inexpensive read-only Gateway balance
  refresh and public agent discovery. Their conservative wallet/IP or IP quotas
  still apply whenever the limiter backend is available.
- Private buyer/seller/accounting reads remain wallet-session authorized and do
  not call an external cost-incurring service. They are not made unavailable
  solely because the shared limiter backend is down.

Wallet and trusted-client-IP buckets remain independent. Direct client-supplied
forwarding headers are not trusted unless the deployment explicitly configures
the trusted boundary.

## Balance and ambiguous-withdrawal UX

A valid Gateway balance of zero is displayed as zero. Refresh errors preserve
the last known good value and add a subtle unavailable indicator. An ambiguous
withdrawal remains reserved and is described as still being confirmed; the only
available recovery action checks/reconciles its durable status and never starts
a second transfer.

## Representative response size

Paid delivery retains the hard 4,000,000-byte serialized response ceiling.
Endpoint verification measures the representative serialized response with
conservative wrapper headroom. Samples at or above 3,500,000 bytes produce the
seller-visible warning “Verification response is near Mahshar's delivery size
limit; larger responses may fail.” A representative sample over the hard limit
cannot set `verified_at` or activate the listing. This is a representative test,
not a promise that later upstream responses cannot be larger.
