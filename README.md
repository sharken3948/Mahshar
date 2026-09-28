# Mahshar — The API economy, powered by USDC.

AI-powered API marketplace. Sellers list APIs and earn USDC per call. Buyers discover and pay for APIs via x402 nanopayments through Circle Gateway — no subscriptions, no API keys required on the buyer side. Mahshar is **Arc Mainnet-only**: production payments use Arc Mainnet (`eip155:5042`).

**Live:** [mahshar.xyz](https://mahshar.xyz) — Arc Mainnet-first (built for the Lepton Hackathon)

---

## Features

### For Sellers
- **AI listing review with live endpoint test** — `/api/ai/score` uses Groq (openai/gpt-oss-120b) to score submissions. It makes a real test call to the seller's endpoint during review and surfaces diagnostics (method, URL, body sent, status code, response snippet) directly in the submission UI — sellers can debug failures without leaving the form. Groq also screens the actual response body for harmful or illegal content before scoring. SSRF protection blocks private IP ranges and redirects.
- **Endpoint verification** — `/api/apis/[id]/verify` pings the seller's endpoint using the real decrypted auth credentials and sets a verified badge on success.
- **AES-256-GCM encrypted credential storage** — Seller API keys are encrypted at rest with authenticated encryption (random 12-byte IV + auth tag per record). Credentials are never stored or transmitted in plaintext.
- **Real-time seller dashboard** — Earnings breakdown by API, per-API call analytics (avg latency, success rate, call history), and live Circle Gateway USDC balance.

### For Buyers
- **AI-powered semantic search** — `/api/ai/match` takes a natural-language query and returns the best-matching active APIs using Groq.
- **x402 nanopayment flow** — Buyers pay per call via EIP-712 `signTypedData` signing of a `TransferWithAuthorization` message (the authorization concept defined in EIP-3009), settled through Circle Gateway. Every 402 response advertises **Arc Mainnet** (`eip155:5042`) only.
- **Request body editor** — POST and PUT APIs show a JSON editor pre-filled with the listing's example request. Buyers can modify the payload before calling.
- **Smart retry messaging** — consecutive transient failures (rate limits, 503s) surface a helpful retry prompt rather than a generic error.
- **Gateway balance funding** — Production buyers deposit USDC into their Circle Gateway balance on Arc Mainnet. Circle Bridge Kit funds the Arc wallet; App Kit Unified Balance handles the subsequent explicit deposit.
- **Optional prepaid credits** — `/api/payments/credits` supports a prepaid credit balance as an alternative to per-call x402 payments.

### Platform
- **Smart auto-deactivation** — Distinguishes seller-fault failures (5xx, timeouts, 401/403 from upstream) from client-fault failures (400/404/405/422 from malformed requests). Requires failures from at least 2 distinct buyer wallets before deactivating a listing. Prevents a single misconfigured client from taking down a healthy API.
- **Agent discovery endpoint** — `/api/agent/discover` returns a machine-readable catalog with EIP-712 payment domain info, step-by-step payment instructions, and live per-API stats (`total_calls`, `success_rate`, `avg_latency_ms`) so autonomous agents can discover and pay for APIs without human interaction.

---

## How It Works

### Sellers
1. Connect wallet and fill the listing form (name, description, category, endpoint URL, auth credentials, example request/response).
2. Submit for AI review — Groq scores the listing and makes a live test call to the endpoint. Live diagnostics (status, response snippet) are shown inline. Blocked if critical issues or unsafe content are found.
3. Set a price per call in USDC and activate. The listing appears in the marketplace immediately.

### Buyers
1. Search by natural language ("wallet risk scoring for Ethereum addresses") or browse by category.
2. Click **Use API** — POST, PUT, and DELETE APIs with an example body open a JSON editor pre-filled from that example. The browser then probes `/api/proxy`, receives a 402 with a `PAYMENT-REQUIRED` header, signs a `TransferWithAuthorization` EIP-712 message in the connected wallet, and submits the payment.
3. Mahshar verifies and settles the payment via Circle Gateway, then proxies the request to the seller's endpoint and returns the response. The seller's URL and credentials are never exposed to the buyer.

---

## Architecture

### Proxy pattern
Every buyer request goes through the proxy layer. Two routes are exposed:

- **`POST /api/proxy` (envelope)** — supports configured GET, POST, PUT, and DELETE methods. Body carries `{ api_id, buyer_wallet, method?, path?, body? }`; the inner `body` is forwarded for non-GET methods. The settled payment payer—not `buyer_wallet`—is authoritative for ownership and analytics.
- **`GET|POST /api/proxy/[api_id]` (path route)** — available only when the listing is configured for that same GET or POST method. POST JSON is parsed and re-serialized. A mismatch returns 405; PUT and DELETE use the envelope route.

Both routes share the same 402 builder and durable payment verifier. Mahshar injects `x-api-key`, `Authorization: Bearer`, or the seller-configured query parameter server-side; buyer headers are not forwarded. Paid results use a JSON wrapper with `response`, `latency_ms`, `payment`, `delivery_state`, `attemptId`, and `purchase_access_token`. The final serialized JSON response is capped at 4,000,000 bytes; oversized responses return 502 with `FAILED_FINAL`. Buyers never see seller credentials or the real endpoint URL.

### Payment flow
```
Buyer → POST /api/proxy          (envelope route, browser)
        or  /api/proxy/[api_id]  (path route, agents)
      ← 402 + base64-encoded PAYMENT-REQUIRED header
        (accepts[] offers Arc Mainnet only)
Buyer signs TransferWithAuthorization EIP-712 message
        for their Arc Mainnet Gateway balance
Buyer → same URL and method      (Payment-Signature header)
      → Circle Gateway: verify + settle
      ← PAYMENT-RESPONSE (standard x402 v2 settlement metadata)
      → Seller's endpoint (proxied)
      ← JSON response wrapper + purchase-access capability
      → Arc Memo contract: onchain receipt (api_name, seller_wallet, call_id)
```

Settlement/accounting and delivery are separate durable states. Replaying an identical proof never settles twice. Only a failure proven to occur before upstream dispatch is `FAILED_RETRYABLE`; timeouts, interrupted workers, and ambiguous transport outcomes are `UNKNOWN` and are not automatically rerun. Upstream 4xx/5xx responses are `FAILED_FINAL`. See [Agent integration](docs/agent-integration.md).

### Arc Memo onchain receipts
After every successful x402 proxy call, `src/lib/memo.ts` writes an onchain receipt to the Arc Memo contract (`0x5294E9927c3306DcBaDb03fe70b92e01cCede505`) containing the API name, seller wallet, and call ID. The call is fire-and-forget — a memo failure never blocks the buyer response. Each receipt is indexed by `keccak256(call_id)` and the metadata is ABI-encoded as `(string apiName, address sellerWallet, string callId)`.

### Official Circle Mainnet bridge and deposit

The redesigned Bridge page uses Circle Bridge Kit for every Mainnet native-USDC source whose official SDK provider confirms a route to the connected EVM wallet on Arc Mainnet (5042). Chain metadata and wallet networks come from the SDK registry; forwarding is checked per route. When forwarding is unavailable, Circle's official EVM destination adapter handles the Arc mint with an explicit wallet signature. Browser wallets use Circle's viem and Solana adapters. Incomplete SDK results are retained for `kit.retry()`; uncertain submissions do not automatically start a new burn.

After arrival, open Wallet Deposit. It reads the actual Arc USDC balance and deposits the user's chosen amount through `appKit.unifiedBalance.deposit`, never the pre-fee bridge input. Leave Arc USDC for gas. Buyer withdrawals use Unified Balance; seller accounting and the existing signed Gateway withdrawal flow are preserved.

Historical custom bridge code, routes, fixtures, operator tools and SQL have been deleted, including old bridge implementations in local backups. The application uses only the official Circle bridge path.

Mainnet Memo deployment and ABI: https://docs.arc.io/arc/references/contract-addresses and https://docs.arc.io/arc/concepts/transaction-memos. Payment memos are auxiliary onchain references, not settlement evidence; failures do not change accounting.

Configuration: `ARC_MAINNET_RPC_URL` (server), optional `NEXT_PUBLIC_ARC_MAINNET_RPC_URL` (browser), `NEXT_PUBLIC_SOLANA_RPC_URL` or existing `NEXT_PUBLIC_HELIUS_API_KEY`. Only use Mainnet endpoints. Existing x402 Mainnet preview headers remain required by the installed SDK. No Circle package upgrade was needed.

## For AI Agents

Start with `GET /api/agent/discover`; it links the public OpenAPI document at `/api/openapi` and supplies per-listing method, proxy style, request/body/schema/path metadata, auth type, price, examples, response wrapper, recovery states, and rate limits. Seller upstream URLs and credentials are omitted.

```json
{
  "marketplace": "Mahshar",
  "network": "eip155:5042",
  "payment_protocol": "x402",
  "payment_domain": {
    "name": "GatewayWalletBatched",
    "version": "1",
    "verifyingContract": "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE"
  },
  "usdc_asset": "0x3600000000000000000000000000000000000000",
  "how_to_pay": "...",
  "apis": [
    {
      "id": "...",
      "name": "...",
      "price_per_call_usdc": 0.001,
      "method": "GET",
      "proxy_style": "path",
      "proxy_url": "https://mahshar.xyz/api/proxy/<id>",
      "total_calls": 42,
      "success_rate": 0.98,
      "avg_latency_ms": 1240
    }
  ]
}
```

This example shows the Arc Mainnet payment selection. The discovery response and its `networks` array describe Arc Mainnet only.


**Circle Agent Wallet (recommended alternative):** Instead of `BUYER_PRIVATE_KEY`, use a Circle CLI agent wallet for autonomous payments — no raw private key required. See [Agent Wallet Integration](#agent-wallet-integration) below.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.9 (App Router, Turbopack) |
| Language | TypeScript, React 19 |
| Styling | Tailwind CSS 4 |
| Database | Supabase (Postgres) |
| AI | Groq — openai/gpt-oss-120b |
| Wallet / Web3 | RainbowKit 2.2.11, wagmi 2.19.5, viem 2.52 |
| Payments | `@circle-fin/x402-batching`, `@circle-fin/bridge-kit`, `@circle-fin/app-kit`, Circle Gateway (Arc Mainnet) |
| Chains | Arc Mainnet (chain ID 5042, USDC as native gas token) |

> **Agent Wallet CLI** (`@circle-fin/cli`) is a separate global tool — not in `package.json`. Install it with `npm install -g @circle-fin/cli`. See [Agent Wallet Integration](#agent-wallet-integration).
| Encryption | AES-256-GCM (Node.js `crypto`) |

---

## Getting Started

```bash
git clone https://github.com/sharken3948/Mahshar.git
cd Mahshar
npm install
cp .env.example .env.local
# Fill in all required variables (see .env.example for descriptions)
npm run dev
```

### Required environment variables

See `.env.example` for full descriptions. Required:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `GROQ_API_KEY` | Groq API key for AI scoring and matching |
| `ENCRYPTION_KEY` | 64-char hex string (AES-256-GCM key) — generate with `openssl rand -hex 32` |
| `ARC_MAINNET_RPC_URL` | Server-side Arc Mainnet RPC; passed explicitly to Arc Gateway/RPC clients |
| `PLATFORM_WALLET_ADDRESS` | Platform wallet that receives and forwards payments |
| `PLATFORM_WALLET_PRIVATE_KEY` | Private key for the platform wallet (also used for Arc Memo writes) |
| `INTERNAL_API_SECRET` | Shared secret for server-to-server credit operations |
| `ADMIN_WALLETS` | Comma-separated server-only wallet allowlist for one-use admin authorization |
| `MARKETPLACE_ORIGIN` | Canonical HTTPS production origin used in discovery, OpenAPI, proxy, and x402 execution URLs |
| `MAHSHAR_TRUSTED_CLIENT_IP_HEADER` | Optional, non-Vercel only: edge-overwritten client-IP header used for rate-limit dimensions |

---

## API Routes

| Route | Method | Description |
|---|---|---|
| `/api/proxy` | POST | Payment gateway + request proxy (envelope body: `{api_id, buyer_wallet, body, …}`) |
| `/api/proxy/[api_id]` | GET, POST | Matching GET/POST listings only; POST JSON is parsed and re-serialized. |
| `/api/apis` | GET, POST | List active APIs / create listing |
| `/api/apis/[id]` | GET, PATCH, DELETE | Owner-signed private configuration read / update / delete |
| `/api/apis/[id]/verify` | POST | Live endpoint verification |
| `/api/apis/latency` | GET | Average latency per API from call history |
| `/api/ai/match` | POST | Semantic API search via Groq |
| `/api/ai/score` | POST | AI listing review with live endpoint test |
| `/api/agent/discover` | GET | Machine-readable catalog for autonomous agents |
| `/api/openapi` | GET | Current public OpenAPI 3.1 document |
| `/api/seller/earnings` | GET | Earnings breakdown by API |
| `/api/seller/calls` | GET | Per-API call analytics for a seller |
| `/api/calls` | GET | Buyer call history |
| `/api/calls/last-response` | GET | Last response for a purchased API |
| `/api/gateway/balance` | GET | Live Circle Gateway USDC balance |
| `/api/payments/credits` | GET, POST | Prepaid credit balance management |
| `/api/payments/x402` | POST | Retired V1 endpoint; returns 410 and points to `/api/proxy` |
| `/api/payments/reconcile` | POST | Owner-signed accounting reconciliation; never resettles or reruns upstream |
| `/api/purchases` | GET | Purchase history |

---

## Agent Wallet Integration

The Circle CLI (`@circle-fin/cli`) provides a **Smart Contract Account (SCA) agent wallet** that can autonomously pay for Mahshar APIs without MetaMask, a browser, or exposing a raw private key. Payments are signed off-chain using EIP-3009 and settled gaslessly via Circle Gateway.

### Setup

```bash
# 1. Install the Circle CLI
npm install -g @circle-fin/cli

# 2. Log in with email OTP (two-step, non-interactive)
circle wallet login <your-email> --type agent --init
# → enter OTP when prompted:
circle wallet login --type agent --request <request-id> --otp <code>

# 3. Create an agent wallet for Arc Mainnet
circle wallet create --output json

# 4. Fund the wallet with mainnet USDC on Arc Mainnet.
# Verify the Arc Mainnet chain option supported by your installed Circle CLI before moving funds.

# 5. Deposit into Circle Gateway on Arc Mainnet (required before making x402 payments).
# Verify the Arc Mainnet chain option supported by your installed Circle CLI before running a deposit.

# 6. Confirm the Arc Mainnet Gateway balance using your installed Circle CLI.
```

### Making a Payment

```bash
circle services pay https://mahshar.xyz/api/proxy \
  --method POST \
  --chain <ARC_MAINNET_CHAIN> \
  --address <wallet-address> \
  --max-amount 0.1 \
  --data '{"api_id":"<api-id>","buyer_wallet":"<wallet-address>","method":"PUT","body":{...}}'
```

Or, using the path route directly — the body is whatever the upstream API expects, no envelope:

```bash
circle services pay https://mahshar.xyz/api/proxy/<api-id-from-discovery> \
  --method POST \
  --chain <ARC_MAINNET_CHAIN> \
  --address <wallet-address> \
  --max-amount 0.1 \
  --data '{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","chain":"arc"}'
```

Choose the URL and method from the selected discovery record. Select Arc Mainnet (`eip155:5042`) using the network option supported by your current Circle client; the 402 advertises only that network.

### How It Works

Circle agent wallets are SCAs — the CLI holds the signing key internally; only the wallet address is ever shared. When `circle services pay` runs:

1. The CLI sends an unauthenticated POST to `/api/proxy`, receives a `402 + PAYMENT-REQUIRED` header.
2. It signs an EIP-3009 `TransferWithAuthorization` for the advertised amount and resubmits with a `Payment-Signature` header.
3. Mahshar calls `BatchFacilitatorClient.settle()` → Circle Gateway debits the agent wallet's Gateway balance and credits the platform wallet.
4. The seller's endpoint is proxied and the response is returned.

When constructing `GatewayClient` directly for Arc Mainnet, pass `chain: 'arc'`, an explicit `rpcUrl: process.env.ARC_MAINNET_RPC_URL`, and the installed SDK's Arc Mainnet preview configuration. Do not remove `arcPrivateMainnet` / `X-ARC-PRIVATE-MAINNET-ENABLED` from the corresponding facilitator path.

`purchases.tx_hash` is a durable settlement identity and is not guaranteed to be an EVM transaction hash. The standard `PAYMENT-RESPONSE` header is the machine-readable settlement response.

### Standalone zero-knowledge agent harness

`scripts/mahshar-agent-e2e.mts` uses only discovery, OpenAPI, proxy, x402 headers, and purchase-access HTTP APIs. Its default mode cannot sign or pay. Live mode is explicitly gated and aborts above `0.001 USDC` per listing; see [Agent integration](docs/agent-integration.md) for the exact command and safety requirements.

---

## Circle Skills

This repo ships 17 Circle Skills under `.agents/skills/` (skill files live there; `.claude/skills/` contains symlinks pointing into `.agents/skills/`), installed via `npx skills add circlefin/skills`. They provide Claude Code contributors with guided patterns for Arc, USDC, Gateway, CCTP, and more. Skills are loaded automatically when Claude Code detects a relevant task.

---

## License

MIT
