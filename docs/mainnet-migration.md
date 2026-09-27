# Official Circle Mainnet migration inventory

> Historical implementation inventory. For the current public autonomous-agent
> contract and current validation guidance, use [Agent integration](agent-integration.md)
> and the served `/api/openapi` document.

This inventory describes this task, relative to the existing dirty worktree, rather than changes since Git HEAD. Existing marketplace, authentication, durable settlement and redesigned UI work was preserved.

## Added or edited files

- `src/app/api/agent/discover/route.ts`
- `src/app/api/payments/x402/route.ts`
- `src/app/api/proxy/[api_id]/route.ts`
- `src/app/api/proxy/route.ts`
- `src/app/api/seller/withdraw/confirm/route.ts`
- `src/app/api/seller/withdraw/route.ts`
- `src/app/dashboard/dashboard-workspace.tsx`
- `src/app/dashboard/solana/page.tsx`
- `src/app/dashboard/wallet/bridge/bridge.module.css`
- `src/app/dashboard/wallet/bridge/page.tsx`
- `src/app/dashboard/wallet/page.tsx`
- `src/app/providers.tsx`
- `src/hooks/useBridge.ts`
- `src/hooks/useSolanaBridgeBalance.ts`
- `src/lib/arc.ts`
- `src/lib/chains.ts`
- `src/lib/circle-bridge.ts`
- `src/lib/gateway.ts`
- `src/lib/memo.ts`
- `README.md`
- `package.json`
- `tsconfig.json`
- `next.config.ts`
- `scripts/get-supported-chains.mts`
- `scripts/verify-x402-mainnet.mts`
- `supabase/migrations/20260923000300_x402_settlement_durability.sql`
- `tests/mainnet/register.mjs`
- `tests/mainnet/flows.test.ts`
- `tests/marketplace/next.ts`
- `tests/x402/integration.test.ts`
- `.env.local` (removed only the unused `NEXT_PUBLIC_SHOW_TESTNET` key; other values preserved)
- `WORKLOG.md`
- `docs/mainnet-migration.md` (this inventory)

## Final cleanup

The historical archive and old bridge/Gateway/Testnet implementations in local backups have been deleted. The current official Circle implementation remains unchanged. See [cleanup inventory](final-cleanup.md) for the exact deletion list.

## Official sources and runtime

BridgeKit owns route execution, CCTP construction, forwarding and retry. Mahshar retains only wallet/UI state and SDK result recovery. AppKit Unified Balance handles deposits from the actual Arc wallet balance. Circle x402 Mainnet RPC and preview headers remain.

[Arc Mainnet contracts](https://docs.arc.io/arc/references/contract-addresses) and [Memo semantics](https://docs.arc.io/arc/concepts/transaction-memos) establish the Memo deployment and API. Auxiliary memo writes require chain 5042 and successful receipts; memo failure cannot change payment accounting.

No dependency upgrades, production database connections/migrations, wallet prompts, real transactions, commits or deployment were performed. Builds use dummy credentials and local-only database/RPC endpoints. Generated Next route declarations may change during the build.

## Validation limits

Offline Mainnet SDK-wiring/Memo tests: 11 passed. x402 integration: 6 passed. Durable x402 settlement: 14 passed. Marketplace: 33 passed, 6 failed; all six failures reproduced on the pre-change source snapshot. They concern endpoint editing/verification/scoring, sessionless proxy status, and the retired payment endpoint status expectation. Production build (`npm run build -- --webpack`) and its TypeScript check passed with dummy/local-only endpoints. An upstream ox/viem dynamic-dependency warning remains. The final route manifest contains no custom bridge API routes. No claim of live Mainnet execution is made.

The local settlement migration now accepts only Mainnet. No deployed database schema was inspected or changed; editing local SQL does not alter an already-applied remote function.
