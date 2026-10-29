# ERC-8004 V1: public, headless identity lookup

V1 is an optional read-only API. Autonomous agents can discover the interface,
resolve an existing ERC-8004 ID and compare its current on-chain relationships
with any wallet, without a browser, login, signature, payment or transaction.
The response is **not authentication, a binding, a capability or an endorsement**.
Existing agents can ignore this feature entirely.

## Interface

`GET /api/agent/identity` without query parameters returns a machine-readable
descriptor: supported chain/registry, required and optional fields, semantics
and error codes. Requests with query parameters must include the complete tuple:

```sh
curl --get 'https://mahshar.xyz/api/agent/identity' \
  --data-urlencode 'chain_id=5042' \
  --data-urlencode 'registry=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' \
  --data-urlencode 'agent_id=0' \
  --data-urlencode 'wallet=0xd305607510e0db2c95807173c7a05bea53c1ed36'
```

The optional `wallet` is only an address to compare. Do not send cookies,
payment signatures, purchase capabilities or private metadata. Only Arc Mainnet
5042 and the specified IdentityRegistry are accepted. IDs are canonical decimal
strings (`0` through uint256 max), with bigint arithmetic internally; JSON
numbers, leading zeroes, exponents, duplicate/unknown query fields, arbitrary
registries, RPC URLs and registration URLs are rejected. Wallets must be
nonzero 20-byte hexadecimal addresses; comparisons are case insensitive.

A successful response has this shape (values depend on the returned block):

```json
{
  "schema_version": "1",
  "verification": "onchain_snapshot",
  "chain_id": 5042,
  "registry": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "agent_id": "0",
  "owner": "0xd305607510e0db2c95807173c7a05bea53c1ed36",
  "agent_wallet": "0xd305607510e0db2c95807173c7a05bea53c1ed36",
  "wallet_relationship": {
    "wallet": "0xd305607510e0db2c95807173c7a05bea53c1ed36",
    "is_owner": true,
    "is_agent_wallet": true
  },
  "requester_authenticated": false,
  "binding_created": false,
  "block": {
    "number": "28515236",
    "hash": "0x6c910dab5ed2cba61abf3b15800de30647c9c741bc7e5534ddb7748ca9131920",
    "timestamp": "1793296711"
  }
}
```

`wallet_relationship` is null when no wallet is supplied. `agent_wallet` is null
when the registry returns the zero address. A nonmatching wallet still receives
HTTP 200 with both comparisons false: lookup succeeded, but the relationship
does not exist. Operator approvals never qualify as either relationship.

| HTTP | Meaning |
| --- | --- |
| 400 | `invalid_identity_query`; no RPC or database call |
| 404 | `agent_not_found`; the recognized registry explicitly reverted with the matching nonexistent token ID |
| 429 | `rate_limited`; honor `Retry-After` |
| 503 | `identity_unavailable` or `rate_limit_unavailable`; facts are unknown, not disproved |
| 405 | Mutation methods unsupported by the Next route |

All GET responses use `Cache-Control: no-store`. Each lookup reads fresh state
at one block number and confirms its hash again. Repeat the lookup to observe
NFT transfers, registered wallet replacement or removal. A response is a dated
snapshot, not a durable authorization or guarantee against future changes.
Replaying a lookup or copying its response grants no permissions. V1 creates no
authentication token or signed claim requiring a new nonce/replay protocol.

## What is verified

The server checks RPC chain ID, registry/proxy and implementation bytecode hashes,
ERC-165/721 support, rejection of the invalid interface, version, NFT existence,
owner and registered agent wallet. All contract reads use one recent block.
Stale blocks (over 120 seconds), blocks over 30 seconds in the future and
observed reorganizations fail closed. An implementation upgrade requires review
and an intentional hash update. The total RPC budget is 12 seconds with a
4-second per-call timeout and no retries. No successful identity cache exists.

These are facts obtained from the configured trusted RPC, not independently
verified consensus/storage proofs. No requester signature is checked, and neither
`is_owner` nor `is_agent_wallet` proves the caller controls that wallet. Contract
wallet addresses work like EOAs for comparison; V1 does not perform or claim an
ERC-1271 authentication check. The registry's registered wallet is distinct from
the NFT owner and from arbitrary addresses advertised in metadata.

The existing Mahshar login verifies a one-use EIP-712 challenge (with an on-chain
verification fallback), then establishes an eight-hour cookie session. It is
cryptographic authentication and can technically be exercised by an HTTP client
that implements signing, Origin and cookie handling. The current agent/MCP
contract does not expose a reusable identity-binding workflow. V1 does not extend
that browser account flow, introduce another signing/delegation protocol or
require agents to adopt sessions. `buyer_wallet` alone is not authentication;
payment signatures and purchase capabilities authorize their existing specific
operations only. None is interpreted by the identity endpoint.

## Isolation, privacy and deployment

Only `src/lib/agent-identity.ts` and `src/app/api/agent/identity/route.ts` add
production behavior. No identity database table, migration, schema/type change,
buyer association or identity write exists. The existing rate-limit RPC is the
sole database operation: its separate `agent-identity` IP budget is 30/minute
with fail-closed behavior, using the existing shared fallback budget when no
trusted client IP is available. Wallets/agent IDs are not rate-limit dimensions.
The identity reader itself has no database dependency. No purchases, private
history, financial records, sessions or seller/provider data are read or changed.

The endpoint uses only server-configured `ARC_MAINNET_RPC_URL`, with no public
RPC fallback. RPC redirects are rejected. Registration files, token URIs and
metadata are not fetched or exposed, eliminating registration-URL SSRF in V1.
Provider errors are sanitized; URLs/credentials are not returned or logged by
the reader. As with other public URLs, deployment access logs may record query
parameters, so a wallet comparison must not be treated as confidential input.

Registry, RPC or rate-limit failure affects only this optional endpoint. Existing
MCP tools, x402/Gateway settlement, purchase recovery, seller listings, worker
jobs, wallet sessions and UI remain unchanged. No new dependencies, contracts,
registration transactions, reputation scoring, Ando/MPPI integration or automatic
transaction publication are included. ReputationRegistry is checked during
deployment verification only; it is not a runtime dependency.

## Verified Arc deployment

Read-only checks used the configured Arc RPC on 2026-10-29 at block `28515236`,
hash `0x6c910dab5ed2cba61abf3b15800de30647c9c741bc7e5534ddb7748ca9131920`,
timestamp `1793296711`. `eth_chainId` returned `0x13b2` (5042).

| Evidence | IdentityRegistry | ReputationRegistry |
| --- | --- | --- |
| Address | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Proxy bytes | 130 | 130 |
| Implementation | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` |
| Implementation bytes | 14474 | 10491 |
| Version | `2.0.0` | `2.0.0` |

Both proxies have code hash
`0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41`.
Identity implementation hash:
`0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f`.
Reputation implementation hash:
`0x38602de97f1bd86f0a4729f7f3c0a78b1d27892e6eb581272cce5504a68fd00b`.
Identity supports `0x01ffc9a7`, `0x80ac58cd`, `0x5b5e139f`, and rejects
`0xffffffff`. ID `0` returned the owner and wallet shown above.
Reputation `getIdentityRegistry()` returned the exact IdentityRegistry;
`getClients(0)` decoded successfully (one client). These checks establish
deployment/read-interface compatibility, not a full contract security audit.
No write methods or arbitrary metadata URLs were invoked.

References reviewed: [official draft ERC-8004 specification](https://eips.ethereum.org/EIPS/eip-8004)
and [reference IdentityRegistry](https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/IdentityRegistryUpgradeable.sol).

## Development and release phases

1. Implement the isolated public reader/endpoint and its machine-readable
   contract; test validation, privacy, live state changes and failure isolation.
2. Run focused/regression tests, TypeScript, production build and a read-only
   configured-RPC check. Review and authorize a separate release. No production
   migration or configuration change is required by this patch; verify existing
   RPC and rate-limit configuration in the intended release environment.

Offline focused suite (real route, viem encoding/decoding and rate limiter;
mocked RPC transport and isolated database boundary):

```sh
node --import tsx --import ./tests/agent-identity/register.mjs tests/agent-identity/run.mjs
./node_modules/.bin/tsc --noEmit --incremental false
npm run build
```

Optional read-only live verification, with `ARC_MAINNET_RPC_URL` supplied securely
in the environment (the script does not load `.env` files):

```sh
node --import tsx --import ./tests/agent-identity/register.mjs tests/agent-identity/verify-rpc.ts
```

`tests/agent-identity/http-smoke.mjs` checks the actual built Next HTTP route,
including 405 responses. It requires a build using dummy Supabase URL
`http://127.0.0.1:54321`; it binds its own rate-limit-only fixture on that port
and refuses to reuse an existing service. With the RPC environment supplied it
also resolves ID zero and checks a nonexistent ID through live read calls.

`registry-snapshot.json` contains public bytecode from the verified block, not
credentials or buyer records. It allows upgrade/hash rejection tests to run
offline. Persistent authenticated identity binding, requester wallet-control
proofs, metadata discovery, reputation and Buyer UI remain outside V1.

## Implementation validation (2026-10-29)

Base: GitHub main `2e817e7c1d9cd35ba3e3c55d9707f58603c8059a`, fetched and
used for the clean isolated `feat/erc8004-agent-identity-v1` worktree.

- Identity suite: 15/15 pass, including timeout, database isolation, loss/change
  of relationships, wrong chain, bytecode upgrades and reorganized snapshots.
- Standalone TypeScript and Next 16.3.5 production build pass. Build used
  synthetic wallet/encryption configuration and local dummy database/RPC URLs;
  expected SEO catalog read warnings reflect the absent fixture catalog.
- Built HTTP route passes descriptor 200, invalid-query 400, mutation-method
  405, live ID-zero 200 and nonexistent-ID 404 checks. The only database traffic
  was to a locally bound rate-limit fixture; live RPC calls were read-only.
- Configured-RPC verification of the completed reader passed again at block
  `28516120`, hash `0xdd198d31d403e83c6e7b22193080d72f64c9e21cdc192721b67f1562294d731d`.
- Existing regressions: x402 integration 22/22, wallet/session switching 28/28,
  and session/discovery/MCP/recovery group 63/63 pass outside the restricted
  sandbox. The previously failing test,
  `tests/marketplace/purchase-recovery.test.ts` (separate restarted process),
  produced empty subprocess output/JSON parse failure because the sandbox
  rejected `spawnSync` with `EPERM`. The same failure reproduces against an
  unmodified archive of the verified base. Both recovery suites pass 7/7 when
  subprocess execution is permitted; no recovery, payment or test-harness code
  was changed. This is a test-environment restriction, not a recovery regression.
- Original workspace: all 1,731 uncommitted entries and their content digest
  match the initial snapshot. No files staged, committed or pushed; no production
  migration, configuration change, deployment or on-chain transaction performed.

No ERC-8004 release blocker remains. All 128 focused identity and compatibility
tests pass. This is the focused release suite, not every test in the repository.
