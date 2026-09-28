# Seller statistics authorization

`GET /api/seller/statistics/[wallet]` is private seller/accounting data. A
request must include a fresh one-use wallet-operation authorization whose
wallet claim matches the normalized wallet in the route. Missing, mismatched,
expired, or replayed proofs are rejected.

The endpoint exposes only:

- aggregate gross purchase revenue and paid purchase count
- accumulated seller share already persisted on purchase rows
- aggregate reserved withdrawal amount and calculated withdrawable amount
- aggregate earnings and paid purchase count by API
- non-secret listing metadata needed by the direct edit screen: ID, name,
  description, category, current price, payment model, seller wallet, endpoint,
  method, authentication mode and parameter name, examples, score, uptime,
  creation time, active state, and verification time

It still does not expose buyer wallets, purchase rows, payout history, withdrawal
rows or transaction hashes, encrypted/plaintext credentials, response history,
or any mutation capability.

Financial values use the existing immutable `purchases` ledger,
`seller_share_usdc` values, withdrawal reservation statuses, and
`aggregateSellerStatistics` arithmetic. Historical purchases with no stored
seller share contribute to gross revenue and paid-call counts but do not become
withdrawable.

Public marketplace catalog reads remain available through the active-listing
catalog without a seller-wallet filter. Seller withdrawals continue to require
their existing per-request wallet signature, timestamp, and nonce.
