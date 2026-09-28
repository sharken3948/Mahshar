# Wallet session authentication

Mahshar uses a database-backed, eight-hour wallet session for browser account
features. Connecting a wallet starts one login flow: the browser requests a
five-minute, one-use challenge, signs the `MahsharLogin` EIP-712 message, and
submits it for server verification. The message binds the normalized wallet,
Mahshar application name, Arc Mainnet chain ID 5042, canonical
`MARKETPLACE_ORIGIN`, nonce, issue time, and deadline.

The server atomically consumes the challenge and sets an opaque random session
cookie. Only the SHA-256 token hash is stored in `wallet_sessions`. The cookie is
HttpOnly, SameSite=Lax, Path=/, Secure in production, and unavailable to normal
client JavaScript. Sessions have a fixed eight-hour server expiry and do not
roll forward through activity. Expired/revoked sessions and expired challenges
are removed by the existing protected daily maintenance job.

One shared `MarketplaceSessionProvider` owns login and request coordination.
Concurrent dashboard/navbar/page reads for the same normalized wallet reuse one
in-flight check or login, so React remounts and background refreshes do not open
additional signature prompts. A rejected signature is not retried until the
user explicitly selects Sign in. A valid same-wallet cookie survives refreshes.
Switching wallets clears private client state and establishes a distinct session
for the new wallet; disconnect revokes the active browser session where
practical.

Private reads, low-risk listing management, AI scoring/verification, admin
operations, balance/accounting reads, and accounting reconciliation use the
session. Handlers derive authority from the session wallet and only accept body,
query, or route wallet values as matching consistency claims. Public active
catalog and x402 proxy/discovery routes remain public or payment-authorized.

Sensitive listing edits are a narrowly scoped step-up case. Changes to the
endpoint, upstream authentication or credential, HTTP method, or declared
path/query forwarding contract require the owner session plus a fresh
five-minute, one-use EIP-712 proof over the exact PATCH body and listing route.
Presentation, pricing, examples, and other fields that cannot redirect stored
credentials remain session-only.

Cookie-authenticated mutations require the request Origin to equal the validated
canonical `MARKETPLACE_ORIGIN`; cross-site Fetch Metadata is also rejected.
SameSite=Lax provides an additional browser boundary. Login challenge and verify
endpoints have bounded request bodies and fail-closed IP rate limits.

Seller withdrawal is deliberately different. Both withdrawal routes require the
owner session, and starting or reconciling a withdrawal still requires the
existing fresh operation-specific signature, timestamp, amount or withdrawal ID,
destination context, and one-use nonce. Session authentication does not replace
the atomic reservation, ambiguous-execution fence, or idempotent reconciliation.

No new signing secret environment variable is required. Required configuration
is the existing server-only Supabase service role, `MARKETPLACE_ORIGIN`, Arc
Mainnet RPC configuration, and `CRON_SECRET` for scheduled pruning. Apply the
forward wallet-session migration before deploying code that serves these routes.
