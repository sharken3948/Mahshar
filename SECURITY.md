# Security Policy

Mahshar handles payment state, seller API credentials, wallet authorization, and marketplace accounting. Security reports should be shared privately before public publication so the issue can be investigated and addressed without exposing users or credentials.

## Reporting a Vulnerability

Mahshar does not currently publish a dedicated security-reporting address. Use the existing maintainer contact at [support@mahshar.xyz](mailto:support@mahshar.xyz), identify the message as a private security report, and avoid opening a public issue until coordinated disclosure has been discussed.

When possible, include:

- The affected route, component, or integration.
- Attacker prerequisites and required privileges.
- Reproduction steps for a controlled environment.
- Expected behavior and observed behavior.
- Potential user, credential, payment, or availability impact.
- Test transaction IDs when they are relevant and safe to share.

Do not include real private keys, wallet seed phrases, seller credentials, session cookies, purchase capabilities, or unrelated user data. Redact secrets from requests, logs, screenshots, and transaction evidence.

## Scope

Security-relevant areas include:

- Wallet login, challenge, cookie, and session handling.
- Seller identity and listing ownership authorization.
- Seller credential storage, use, and non-disclosure.
- Upstream path, query, and canonical-target authorization.
- x402 verification, settlement, accounting, and delivery state.
- Purchase-scoped response recovery.
- Seller withdrawal reservation, submission, mint, and reconciliation.
- Database roles, grants, functions, and authorization boundaries.
- Rate limiting, response bounds, and resource-exhaustion controls.
- Arc Mainnet, Circle Gateway, Bridge Kit, and App Kit integration boundaries.

## Responsible Testing

Use wallets, listings, credentials, API endpoints, and funds that you own or are explicitly authorized to test.

Do not:

- Access another user's private marketplace or financial information.
- Intentionally disrupt production availability.
- Exfiltrate real seller or third-party credentials.
- Destructively test an external seller's infrastructure.
- Attempt duplicate real-money payments or withdrawals.

Tests involving concurrency, malformed payment state, ambiguous external execution, high request volume, credential forwarding, or destructive database behavior should be reproduced in a controlled local or isolated environment.

## Disclosure

After a report has been confirmed and remediation has been prepared, the reporter and maintainer can discuss an appropriate coordinated-disclosure timeline. This policy does not promise a bounty, payment, or response-time SLA.
