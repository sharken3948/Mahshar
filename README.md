# Mahshar — The API economy, powered by USDC.

AI-powered API marketplace on Arc Testnet. Sellers list APIs and earn USDC per call. Buyers discover and pay for APIs via x402 nanopayments through Circle Gateway — no subscriptions, no API keys required on the buyer side.

**Live:** [mahshar.xyz](https://mahshar.xyz) — Arc Testnet (built for the Lepton Hackathon)

---

## Features

### For Sellers
- **AI listing review with live endpoint test** — `/api/ai/score` uses Groq (llama-3.3-70b-versatile) to score submissions. It makes a real test call to the seller's endpoint during review and surfaces diagnostics (method, URL, body sent, status code, response snippet) directly in the submission UI — sellers can debug failures without leaving the form. Groq also screens the actual response body for harmful or illegal content before scoring. SSRF protection blocks private IP ranges and redirects.
- **Endpoint verification** — `/api/apis/[id]/verify` pings the seller's endpoint using the real decrypted auth credentials and sets a verified badge on success.
- **AES-256-GCM encrypted credential storage** — Seller API keys are encrypted at rest with authenticated encryption (random 12-byte IV + auth tag per record). Credentials are never stored or transmitted in plaintext.
- **Real-time seller dashboard** — Earnings breakdown by API, per-API call analytics (avg latency, success rate, call history), and live Circle Gateway USDC balance.

### For Buyers
- **AI-powered semantic search** — `/api/ai/match` takes a natural-language query and returns the best-matching active APIs using Groq.
- **x402 nanopayment flow** — Buyers pay per call via EIP-3009 `TransferWithAuthorization` signed messages, settled through Circle Gateway on Arc Testnet. Gasless — USDC is the gas token on Arc.
- **Request body editor** — POST and PUT APIs show a JSON editor pre-filled with the listing's example request. Buyers can modify the payload before calling.
- **Smart retry messaging** — consecutive transient failures (rate limits, 503s) surface a helpful retry prompt rather than a generic error.
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
2. Click **Use API** — POST and PUT APIs open a JSON editor pre-filled from the listing's example request. The browser then probes `/api/proxy`, receives a 402 with a `PAYMENT-REQUIRED` header, signs a `TransferWithAuthorization` EIP-712 message in the connected wallet, and submits the payment.
3. Mahshar verifies and settles the payment via Circle Gateway, then proxies the request to the seller's endpoint and returns the response. The seller's URL and credentials are never exposed to the buyer.

---

## Architecture

### Proxy pattern
Every buyer request goes through `/api/proxy`. Mahshar fetches the seller's endpoint URL and decrypted auth credentials from the database server-side, injects the appropriate auth — `x-api-key` header, `Authorization: Bearer` header, or `?key=VALUE` URL query parameter — depending on the listing's auth type, forwards the request, and returns the response. Responses are capped at 5 MB; larger upstream payloads are rejected before forwarding. Buyers never see seller credentials or the real endpoint URL.

### Payment flow
```
Buyer → POST /api/proxy (no payment header)
      ← 402 + base64-encoded PAYMENT-REQUIRED header
Buyer signs TransferWithAuthorization EIP-712 message
Buyer → POST /api/proxy (Payment-Signature header)
      → Circle Gateway: verify + settle
      → Seller's endpoint (proxied)
      ← Response to buyer
      → Arc Memo contract: onchain receipt (api_name, seller_wallet, call_id)
```

### Arc Memo onchain receipts
After every successful x402 proxy call, `src/lib/memo.ts` writes an onchain receipt to the Arc Memo contract (`0x5294E9927c3306DcBaDb03fe70b92e01cCede505`) containing the API name, seller wallet, and call ID. The call is fire-and-forget — a memo failure never blocks the buyer response. Each receipt is indexed by `keccak256(call_id)` and the metadata is ABI-encoded as `(string apiName, address sellerWallet, string callId)`.

### Auto-deactivation logic
After each call, `checkAndAutoDeactivate` runs asynchronously:
- Fetches the last 50 calls and filters out client-fault rows (`is_client_error = true`)
- Triggers deactivation if the last 5 non-client-fault calls are all seller-fault failures **and** come from ≥2 distinct buyer wallets
- Also triggers if the success rate drops below 80% over the last 20 non-client-fault calls from ≥2 distinct buyer wallets

### AI review pipeline
`/api/ai/score` makes a real HTTP test call to the seller's endpoint (5-second timeout, redirects blocked) before passing the result to Groq. The model sees the actual live response body, not just the description. Diagnostics — method, URL, body sent, HTTP status, and a response snippet — are returned alongside the score so sellers see exactly what the test call did. Groq also checks the response body for harmful or illegal content; listings are blocked if the safety check fails. The score is written back to the database and used for ranking.

---

## For AI Agents

Send a GET to `/api/agent/discover` to get the full marketplace catalog in machine-readable form:

```json
{
  "marketplace": "Mahshar",
  "network": "eip155:5042002",
  "payment_protocol": "x402",
  "payment_domain": {
    "name": "GatewayWalletBatched",
    "version": "1",
    "verifyingContract": "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
  },
  "usdc_asset": "0x3600000000000000000000000000000000000000",
  "how_to_pay": "...",
  "apis": [
    {
      "id": "...",
      "name": "...",
      "price_per_call_usdc": 0.01,
      "total_calls": 42,
      "success_rate": 0.98,
      "avg_latency_ms": 1240
    }
  ]
}
```

`scripts/test-integration.mts` demonstrates a fully autonomous agent (using `@circle-fin/x402-batching`) that discovers, pays for, and calls a real listed API — [Ioscope](https://ioscope.xyz), a wallet risk-scoring service for Arc/Soneium — with zero human interaction. The script has a hardcoded Ioscope API ID and targets production (`mahshar.xyz`) directly; set `BUYER_PRIVATE_KEY` in your environment before running. In testing: 7/7 successful x402 payments end-to-end. The generated integration code snippet uses syntax highlighting: buyer-supplied input values appear in amber, and `WALLET_PRIVATE_KEY` appears in green to draw attention to the sensitive credential.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.9 (App Router, Turbopack) |
| Language | TypeScript, React 19 |
| Styling | Tailwind CSS 4 |
| Database | Supabase (Postgres) |
| AI | Groq — llama-3.3-70b-versatile |
| Wallet / Web3 | RainbowKit 2.2.11, wagmi 2.19.5, viem 2.52 |
| Payments | `@circle-fin/x402-batching`, Circle Gateway (Arc Testnet) |
| Chain | Arc Testnet (chain ID 5042002) — USDC as native gas token |
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
| `PLATFORM_WALLET_ADDRESS` | Platform wallet that receives and forwards payments |
| `PLATFORM_WALLET_PRIVATE_KEY` | Private key for the platform wallet (also used for Arc Memo writes) |
| `INTERNAL_API_SECRET` | Shared secret for server-to-server credit operations |
| `BUYER_PRIVATE_KEY` | Buyer wallet private key — required only for `scripts/test-integration.mts` |

---

## API Routes

| Route | Method | Description |
|---|---|---|
| `/api/proxy` | POST | Payment gateway + request proxy |
| `/api/apis` | GET, POST | List active APIs / create listing |
| `/api/apis/[id]` | GET, PATCH | Get / update a listing |
| `/api/apis/[id]/verify` | POST | Live endpoint verification |
| `/api/apis/latency` | GET | Average latency per API from call history |
| `/api/ai/match` | POST | Semantic API search via Groq |
| `/api/ai/score` | POST | AI listing review with live endpoint test |
| `/api/agent/discover` | GET | Machine-readable catalog for autonomous agents |
| `/api/seller/earnings` | GET | Earnings breakdown by API |
| `/api/seller/calls` | GET | Per-API call analytics for a seller |
| `/api/calls` | GET | Buyer call history |
| `/api/gateway/balance` | GET | Live Circle Gateway USDC balance |
| `/api/payments/credits` | GET, POST | Prepaid credit balance management |
| `/api/payments/x402` | POST | x402 payment initiation endpoint |
| `/api/purchases` | GET | Purchase history |

---

## Circle Skills

This repo ships 17 Circle Skills under `.agents/skills/` (symlinked to `.claude/skills/`), installed via `npx skills add circlefin/skills`. They provide Claude Code contributors with guided patterns for Arc, USDC, Gateway, CCTP, and more. Skills are loaded automatically when Claude Code detects a relevant task.

---

## License

MIT
