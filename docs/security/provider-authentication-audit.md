# P2 OAuth on deployed P1 — readiness review, 2026-10-23

**Implementation: ready for isolated provider review. P2 Production verdict: NO-GO pending approved real-provider validation and operational prerequisites.** P1 remains deployed and compatible in the tested scope. This task makes no Production change and grants no release approval.

## Source and restoration

Exact baseline: `361f92d9a8b3c1f87597fb66d9c62bd230d8097a`, the operator-supplied deployed P1 commit. New detached worktree: `/tmp/mahshar-provider-oauth-p2-20261023-01`.

Restored from `/mnt/f/Projects/mahshar/backup/provider-auth-P1-P2-20261023T091105Z-ss05b9pn`. All 111 backup checksum entries and 48 implementation manifest files were verified before restoration. The old combined patch was read, not blindly applied: shared files were reconciled against the old ancestor and current P1, retaining deployed P1 validation, credential formats, body-size UI behavior and prior mock cases. P2-only implementation was reused. The original dirty worktree's HEAD, branch, tracked diff and index remain unchanged. Previous backups/worktrees were not overwritten.

P2 contains Client Credentials and Authorization Code + S256 PKCE, server-only operator profiles, encrypted token/state storage, Seller connection UI and buyer connection page. Client Credentials is seller-owned; PKCE supports seller and buyer ownership. There is no arbitrary seller-supplied token URL/scope/redirect, token exposure to browsers, or process-global token cache.

## Narrow corrections

- Preserved the P1 branches of shared analysis/discovery routes and the existing full-body UTF-8 serializer/64 KiB preflight, including retained drafts after 413.
- Corrected the restored request-size test to enumerate static bundles only. Corrected the Chromium size fixture to select headers explicitly after its final PKCE scenario. These were test integration issues, not P1 runtime defects.
- Confirmed a provider compatibility defect from GitLab's official PKCE contract: refresh must include the original redirect URI. PKCE refresh now sends the same fixed server-derived callback URI as initial consent. Added an assertion in concurrent refresh coverage and documentation-derived Bitbucket/GitLab contract cases. No financial algorithm or P1 credential behavior was changed.

## Evidence

Evidence paths below are relative to the isolated worktree and are preserved under `test-evidence/` in the new backup.

| Check | Result | Evidence |
| --- | --- | --- |
| Focused compatibility/security matrix | **277/277 passed**, 30 files, Node 24.22.1 | `validation/evidence/focused-matrix.json`, `.log` |
| OAuth protocol/security cases | **29 passed** (including subcases), within matrix | `tests/provider-auth/oauth.test.ts` matrix entry |
| Mock paid-provider paths | **30/30 passed**, both entrances: 20 existing P1 cases + 10 P2 cases | `tests/provider-auth/paid.test.ts` matrix entry |
| Chromium Seller Create/Edit/Verification | **12/12 auth variants**, plus **6/6** accepted-limit scenarios | `validation/evidence/browser-results.json`, `browser-final.log`, screenshots |
| PostgreSQL 16 full-chain migration | **49 checks passed**, after all 54 P1 migrations | `validation/evidence/postgres-full-chain.log` |
| PostgreSQL 17 full-chain migration | **49 checks passed**, after all 54 P1 migrations | `validation/evidence/postgres17-full-chain.log` |
| Node.js 24 production build | **PASS**, default Turbopack/TypeScript/static generation, Next 16.3.5 | `validation/evidence/node24-build.log` |
| Actual final production Next runtime on localhost | **PASS**, Seller wallet gate renders, unauthenticated Create/OAuth return 401, no page errors | `validation/evidence/runtime-smoke.json`, `.log` |
| Preservation/scope | **PASS**, 54 migrations and 26 protected files byte-identical; paid routes reconstruct exact P1 after removing two OAuth-only insertions | `validation/evidence/scope-integrity.json` |

The matrix also retains existing Seller sessions/proofs, listing contracts, edit/analysis/verification, request/response contracts, x402 integration/settlement/error/delivery and MCP proxy tests. All payments, external providers, database client, AI and wallet browser boundaries are synthetic/mocked. Chromium uses actual React components and actual Seller/OAuth route handlers behind a test-only adapter; actual operation proof checks execute against synthetic fixtures. It exercises CC plus seller/buyer PKCE mock consent, callback, verification, replacements, reconnect and disconnect. It does not claim a real wallet extension or real provider certification.

No USDC transaction, SMS, paid provider operation, real OAuth authorization/token request, Production database connection, migration, deployment, branch switch, stage, commit or push occurred. The known recovery restart-harness failure was accepted as pre-existing before P1; its test/implementation was left unchanged and not reinvestigated. Capability recovery remains covered by mock paid cases.

## Security and P1 compatibility findings

- State is unpredictable, one-use, expires after five minutes and binds listing, encrypted configuration/profile hash, owner/mode, wallet session and HttpOnly browser cookie. Duplicate parameters, denial, wrong wallet/session/browser, expiry, replay and concurrent callback completion fail closed.
- S256 matches the RFC vector. Client secret, verifier, access/refresh tokens and encrypted fields do not appear in public/owner listing projections or browser responses. Server errors are sanitized; token endpoints have bounded responses and no redirect following. Resource reflection checks cover known secret forms. Arbitrary transformations cannot be recognized, so upstreams remain a trust boundary.
- Tokens/verifiers use the existing AES-GCM envelope. Private tables have RLS enabled and deny anon/authenticated access. SECURITY DEFINER functions pin their search path, revoke PUBLIC/anon/authenticated execution and grant only service-role access. Existing encrypted listing credentials keep the same representation.
- Database leases serialize rotating refresh, revision/configuration fencing prevents stale writes, and uncertain acquisition requires reconnect rather than replaying a possibly consumed refresh token. Local disconnect prevents token resurrection even when remote revocation fails.
- Buyer connections are keyed by listing, owner wallet, mode and exact configuration. A missing buyer connection never falls back to seller tokens. OAuth-only preflight blocks missing connections before payment. The settled payer must match the wallet session; mismatch returns 403 without capability/upstream access, retaining same-proof recovery. A mismatch is detected after settlement, so clients must follow the returned no-new-payment retry instruction. Both entrances are covered by mocked mismatch/recovery tests.
- All seven P1/legacy auth modes remain usable without a profile, OAuth table RPC or token request. Prior P1 paid cases and Seller browser cases pass. The accepted 64 KiB Create/Edit/analysis policy and UI guidance/draft retention remain intact. P1 live purchase certification is the operator's prior evidence; no real P1 purchase was repeated.
- Financial/settlement/Gateway/Arc/withdrawal/bridge code, dependency/build configuration and MCP route implementations are unchanged. Both paid entrypoints have exactly two additive OAuth guards each; removing them reconstructs the deployed P1 files byte for byte. No unrelated fixes were included.

No unresolved high/critical defect was confirmed within this focused mocked scope. This is not a broad application audit or a claim that real-provider testing has occurred.

## Migration assessment

Only `20261023162226_provider_oauth_p2.sql` is new. It follows the deployed P1 constraint migration and preserves all seven static values while adding two OAuth values, private accounts/states tables, indexes, service-only lease/finish/complete/disconnect functions and the configuration invalidation trigger. The old combined `20261022000100_provider_authentication.sql` is absent. No historical migration was edited or replayed against a remote database.

Disposable PostgreSQL 16 and 17 tests apply the complete 54-migration chain first, seed every static type and synthetic financial rows, verify transactional rollback restores P1, then apply P2. They verify unchanged legacy rows, existing columns/defaults/ACLs/RLS/functions, static credential changes with the new trigger, private-object privileges, ownership isolation, 32 concurrent lease claims, stale lease/revision/config fencing, callback replay and disconnect. Data preservation is established for seeded isolated fixtures, not claimed for uninspected Production data. The tests use a new Unix-socket cluster with no TCP listener and accept no database URL.

A future release still requires explicit approval, live migration-history/schema/TLS checks and backup readiness. CHECK replacement takes a table lock; Production lock timing/private schema drift were not measured. Retain additive schema on app rollback and disable OAuth listings first. No automatic destructive down migration is supplied.

## Remaining blockers and provider limitations

See `provider-oauth-testing.md` and `provider-oauth-test-profiles.json` for exact application setup, scopes, URLs, credential formats and approval-gated tests.

- **BLOCKED — Bitbucket real Client Credentials:** legitimate dedicated workspace/consumer Key+Secret, test repository and approval to acquire test tokens are not supplied. Recommend Free workspace, Repositories: Read only, `client_secret_basic`, read-only repository endpoint.
- **BLOCKED — GitLab real PKCE:** registered non-confidential app Application ID with `read_user`, stable approved isolated HTTPS origin/exact per-listing callbacks, distinct legitimate test identities and explicit consent approval are not supplied. Real consent, rotating refresh, provider revocation and cross-account resource identity remain unverified.
- **Operational prerequisite:** decide and document expired-state retention/pruning and former-provider revocation handling before rollout. Expired state is unusable but no scheduled cleanup is installed. Remote revocation is best effort; local disconnect remains effective.
- Supported provider contract: Bearer only, numeric lifetime 61 seconds–31 days, bounded 32 KiB response; fixed HTTPS endpoints/resource origins/scopes. No audience/resource extension, client assertion, mTLS, DPoP or non-query callback. Templates are documented candidates, not live provider certification. No new configuration is installed in Production.

**P2: NO-GO for Production; ready for review and separately approved isolated real-provider testing.** P1 compatibility passes. Stop for review; no Production action follows this report.
