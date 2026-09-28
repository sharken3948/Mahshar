# Changelog

All notable changes to Mahshar are documented in this file.

## Unreleased

### Arc Mainnet

- Updated the architecture from earlier testnet assumptions to Arc Mainnet.
- Added production network handling for Arc chain ID 5042.
- Aligned current USDC marketplace, payment, and accounting flows with Arc Mainnet.

### Marketplace

- Added durable, purchase-scoped response recovery.
- Added machine-readable discovery and OpenAPI output.
- Expanded the seller listing contract for method, body, path, query, and schema metadata.
- Added four upstream authentication models: public, API-key header, bearer token, and query credential.
- Added representative response-size verification and seller warnings.

### Wallet Authentication

- Added wallet-bound, database-backed browser sessions.
- Added one-use wallet login challenges.
- Added fixed-duration sessions without indefinite activity-based renewal.
- Isolated authenticated state across wallet switches.
- Retained fresh signatures for withdrawals and security-sensitive listing mutations.

### Proxy Security

- Added canonical target authorization before credential injection.
- Rejected path traversal and encoded traversal variants.
- Enforced declared dynamic-path and query-parameter contracts.
- Added duplicate-query and credential-query collision protection.
- Replaced arbitrary request-path JavaScript regular-expression evaluation with a bounded declarative matcher.
- Kept seller credentials out of buyer responses and public discovery metadata.

### Payments and Delivery

- Added durable x402 settlement and delivery states.
- Linked stored responses to the exact purchase and delivery attempt.
- Bounded final serialized responses.
- Required durable response persistence before marking delivery successful.
- Added durable `UNKNOWN` handling for ambiguous execution.

### Seller Withdrawals

- Added atomic seller withdrawal reservations and concurrency protection.
- Added durable `submission_unknown` and `mint_unknown` states.
- Prevented blind resubmission after ambiguous external execution.
- Made confirmation and reconciliation idempotent.

### Authorization and Privacy

- Bound private buyer and seller data to the authenticated wallet.
- Added listing ownership checks for private reads and mutations.
- Added CSRF protection for session-authenticated mutations.
- Added fresh operation signatures for security-sensitive listing changes.

### Rate Limiting and Availability

- Added independent wallet and trusted-IP rate-limit buckets where applicable.
- Applied risk-proportional fail-open and fail-closed behavior.
- Added observable limiter-backend failure logging.
- Added explicit timeouts to Circle and Gateway requests.
- Kept Gateway failures distinct from a real zero balance.

### Data Lifecycle

- Added recoverable-response expiration and bounded pruning.
- Added a protected scheduled maintenance route.
- Added expired wallet-session and login-challenge pruning.
- Documented and verified the fresh database bootstrap process.

### Dashboard and UX

- Clarified the dedicated Solana to Arc funding workspace and its separate post-bridge deposit step.
- Scoped private dashboard state to the connected wallet.
- Prevented stale responses from a previous wallet from updating the active wallet view.
- Preserved last-known-good balance data during refresh failures.
- Added a distinct balance-unavailable state.
- Added calmer recovery messaging for ambiguous withdrawal states.
- Reduced signature fatigue through a shared wallet-session login flow.

### Testing

Expanded regression coverage for:

- Marketplace security and private-data authorization.
- Genuine PostgreSQL withdrawal concurrency.
- All four upstream authentication models.
- Traversal, encoded traversal, and canonicalization.
- Durable, purchase-scoped response recovery.
- Wallet switching and stale-response isolation.
- Wallet challenge and session authentication.
- Independent wallet/IP rate limiting and backend-failure policy.
- Withdrawal ambiguity and idempotent reconciliation.
- Migration ordering and fresh-database bootstrap.
