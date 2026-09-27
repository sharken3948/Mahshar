# Public seller statistics

`GET /api/seller/statistics/[wallet]` is an intentionally public, read-only
summary keyed by a public EVM wallet address. Mahshar uses it to show seller and
API totals without creating a login session or requesting a wallet signature.

The endpoint exposes only:

- aggregate gross purchase revenue and paid purchase count
- accumulated seller share already persisted on purchase rows
- aggregate reserved withdrawal amount and calculated withdrawable amount
- aggregate earnings and paid purchase count by API
- non-secret listing metadata needed by the direct edit screen: ID, name,
  description, category, current price, payment model, seller wallet, endpoint,
  method, authentication mode and parameter name, examples, score, uptime,
  creation time, active state, and verification time

It does not expose buyer wallets, purchase rows, payout history, withdrawal
rows or transaction hashes, encrypted/plaintext credentials, response history,
or any mutation capability.

Financial values use the existing immutable `purchases` ledger,
`seller_share_usdc` values, withdrawal reservation statuses, and
`aggregateSellerStatistics` arithmetic. Historical purchases with no stored
seller share contribute to gross revenue and paid-call counts but do not become
withdrawable.

Listing writes and sensitive history use one-time, operation-specific wallet
authorizations. Seller withdrawals continue to require their existing
per-request wallet signature, timestamp, and nonce.
