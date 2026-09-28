# Mahshar

**The API marketplace for humans and autonomous agents, powered by USDC on Arc.**

Mahshar lets API providers monetize existing endpoints without rebuilding billing infrastructure. Buyers and autonomous agents can discover APIs, pay per call in USDC, and receive responses through Mahshar's payment-aware proxy.

- **Live:** [https://mahshar.xyz](https://mahshar.xyz)
- **Network:** Arc Mainnet
- **Chain ID:** `5042`

## What Mahshar Does

For sellers:

- List an existing API without changing its backend.
- Set a USDC price per call.
- Support public or credential-protected upstream APIs.
- Keep upstream credentials hidden from buyers.
- Track calls, earnings, and withdrawal state.
- Receive seller earnings through the marketplace accounting flow.

For buyers and agents:

- Discover APIs programmatically.
- Inspect machine-readable API metadata.
- Pay per request using USDC.
- Retrieve responses tied to the exact purchase.
- Never receive the seller's upstream credentials.

## Supported Upstream Authentication

| Model | Upstream behavior |
| --- | --- |
| Public API | No credential is added. |
| API Key | A stored API key is injected as an authorized header only after target validation. |
| Bearer Token | A stored bearer credential is injected into the `Authorization` header only after target validation. |
| Query Credential | A stored credential is added as the configured query parameter only after canonical target authorization. |

Stored credentials are server-side data and are not included in buyer responses or public discovery metadata.

## How a Paid API Call Works

```text
Buyer / Agent
  → Discover API
  → Request paid endpoint
  → x402 payment requirement
  → USDC settlement
  → Canonical target authorization
  → Seller credential injected server-side where required
  → Upstream API
  → Durable purchase-scoped response
  → Buyer / Agent
```

Settlement, delivery, and response recovery have distinct durable identities. A recovery capability can retrieve only the response associated with its exact purchase.

## Arc Mainnet

Mahshar's production network is Arc Mainnet, chain ID `5042` (`eip155:5042`). Marketplace prices, buyer payments, platform accounting, and seller earnings are denominated in USDC.

The installed Circle x402 runtime requires explicit Arc Mainnet RPC configuration and its current Mainnet compatibility settings. See [.env.example](.env.example) and [agent integration](docs/agent-integration.md) for the repository's operational contract.

## Wallet Authentication

Normal browser authentication is designed to avoid repeated signature prompts:

```text
Connect wallet
  → Sign one login challenge
  → Fixed eight-hour authenticated session
  → Use normal marketplace features without repeated wallet prompts
```

The server stores an opaque, wallet-bound session in an HttpOnly cookie. The session has a fixed expiry and does not become permanent through activity. Wallet changes isolate private state and require authentication for the newly connected wallet.

Fresh operation-specific signatures remain required for:

- Seller withdrawals.
- `endpoint_url` changes.
- `auth_type` changes.
- Stored API key, bearer token, or query credential changes.
- Authentication parameter-name changes.
- HTTP method changes.
- Dynamic-path, path-parameter, or query-parameter security-contract changes.

Normal navigation, private reads, and edits to names, descriptions, categories, prices, examples, documentation, and other presentation fields use the existing session.

## Security Architecture

Mahshar includes layered controls for payment-aware proxying and wallet-scoped marketplace data:

- Canonical upstream target validation before credential injection.
- Traversal and encoded-traversal rejection.
- Declared dynamic-path and query-parameter contracts.
- Duplicate-query and credential-query collision protection.
- Seller credential non-disclosure.
- Purchase-scoped response recovery.
- Durable x402 settlement and delivery state.
- Atomic seller withdrawal reservations.
- Durable fencing for ambiguous external execution.
- Wallet-scoped private buyer and seller data.
- Independent wallet and trusted-IP rate-limit buckets where applicable.
- Bounded serialized response delivery.
- A bounded declarative path/query matcher rather than arbitrary request-path JavaScript regular expressions.
- Bounded response-retention and wallet-authentication pruning.
- Origin and Fetch Metadata checks for session-authenticated mutations.
- Fresh one-use operation authorization for sensitive listing changes.

These controls reduce identified risks; they are not a claim that the system is vulnerability-free. See [Security documentation](#security-documentation) and [SECURITY.md](SECURITY.md).

## API Response Safety

Seller verification measures a representative serialized response. A response near Mahshar's delivery limit produces a seller-visible warning, and an over-limit representative response cannot complete verification. The runtime serialized-response limit remains authoritative for every paid delivery.

Verification observes one response and cannot guarantee that the upstream API will return the same size later.

## Seller Withdrawals

Before external withdrawal work begins, Mahshar creates an atomic database reservation against the seller's currently available earnings. Concurrent requests cannot reserve the same earnings twice.

If submission or mint execution becomes ambiguous, the reservation remains locked in a recoverable `submission_unknown` or `mint_unknown` state. Confirmation and reconciliation are idempotent, and ambiguous money-moving operations are not blindly retried. The dashboard presents a status-check action instead of offering a duplicate withdrawal.

## Machine Discovery

Autonomous clients should start with the public discovery endpoint and its current machine contract:

- [OpenAPI document](openapi.yaml)
- [Agent integration guide](docs/agent-integration.md)

Runtime discovery and OpenAPI URLs are generated from the configured canonical marketplace origin.

## Cross-Chain Funding

The dashboard provides explicit Circle Bridge Kit flows for SDK-supported Mainnet USDC routes into the user's connected Arc Mainnet wallet. The dedicated **Solana to Arc** workspace moves supported SPL USDC from a connected Solana source wallet to that Arc wallet. Route availability is derived from the installed SDK rather than a fixed list in this README.

After USDC arrives on Arc, depositing it into the user's Gateway balance is a separate, explicit wallet action through Circle App Kit. Bridge and wallet funding flows remain separate from paid API execution; completing a bridge does not automatically purchase or call an API.

See [dynamic Circle routes](docs/dynamic-circle-routes.md) for implementation details and current limitations.

## Repository Structure

| Path | Purpose |
| --- | --- |
| `src/app/` | Next.js pages, layouts, and route handlers. |
| `src/lib/` | Marketplace, payment, authorization, proxy, and integration logic. |
| `src/components/` | Shared client and server UI components. |
| `supabase/migrations/` | Ordered forward database migrations. |
| `tests/` | Marketplace, payment, database, dashboard, and integration regressions. |
| `docs/` | Detailed architecture, operations, and security documentation. |
| `scripts/` | Read-only audits, local verification, and explicitly gated utilities. |

## Database Setup

Follow [Database bootstrap](docs/database-bootstrap.md). A fresh environment requires the reviewed base schema followed by the complete ordered migration chain; migrations must not be skipped or reordered.

## Security Documentation

- [Wallet and marketplace authentication](docs/security/marketplace-auth.md)
- [x402 settlement and delivery durability](docs/security/x402-settlement-durability.md)
- [Risk-proportional controls](docs/security/risk-proportional-controls.md)
- [Safe listing path and query patterns](docs/safe-listing-patterns.md)
- [Recoverable response retention](docs/response-retention.md)

Security reports should follow [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run dev
```

Type-check the project:

```bash
npx tsc --noEmit --incremental false --pretty false
```

Create a production build:

```bash
npm run build
```

## Environment

Copy [.env.example](.env.example) to `.env.local` and provide the required local values.

Never commit production secrets. Server-only private keys, service-role credentials, encryption material, API keys, internal API secrets, and cron authorization secrets must never use a `NEXT_PUBLIC_` prefix.

## License

MIT.
