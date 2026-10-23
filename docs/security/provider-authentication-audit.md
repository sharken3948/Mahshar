# P1 independent release readiness — 2026-10-23

**P1: GO for independent release, subject to explicit Production migration/deployment approval.** No P1 release blocker remains in the tested scope. P2 is excluded from this artifact and preserved separately; it is not approved for release here.

## Scope and source

Canonical baseline: `0007ed08bc4c3f412bfc179787688bd5bc494675`.
Source: checksum-verified `backup/provider-auth-P1-P2-20261023T091105Z-ss05b9pn` (111 checksum entries, 48 implementation files).
Candidate: `/tmp/mahshar-provider-auth-p1-release-20261023-01`, a new detached worktree.

The original dirty source, prior worktrees and backups were not overwritten. All 48 files in the combined worktree still match its backup manifest. No staging, commit, push, branch switch, Production connection/migration, deployment, real payment, paid provider call, SMS send or real OAuth consent occurred. This was a narrow extraction and release-blocker validation, not another broad audit.

## Minimal separation

- Retained the implemented P1 static validation/resolution, existing AES-GCM credential representation, component/wire reflection checks and Seller lifecycle integration. No authentication feature was reimplemented.
- Removed P2 grant/profile/configuration handling, token and consent helpers, OAuth routes, provider connection page/controls, UI options, auth enum values and P2 tests from this candidate. P2 APIs/page return 404 in the built app. Create/Edit reject its types even if an OAuth environment value is accidentally present.
- Restored both paid API entrances byte for byte to baseline. The proxy keeps only its P1 authentication/reflection integration. Protected financial code, Gateway/Arc requirements, package files and Next build configuration are unchanged.
- Replaced the combined schema dependency with **`20261023091900_provider_authentication_p1.sql`**. This new version only widens the existing auth CHECK to public/API-key/Bearer/query/Basic/headers/Authorization. No P2 table, function, trigger or migration is installed.

The old combined migration is intentionally absent. P1 therefore does not need P2 code, provider profiles, OAuth credentials, token storage or consent. The combined backup/worktree remains complete for later P2 work. Future P2 must be rebased onto P1 with a later forward migration; its old combined patch/migration is not a drop-in upgrade for this candidate.

## User decisions implemented

The 64 KiB edit-body ceiling is accepted. Create, Edit and analysis now share the same UTF-8 byte constant. The UI displays that limit, checks the serialized body before sending/signing, handles server/edge 413 responses clearly and preserves drafts/replacement credentials. Reducing input permits saving the same draft. Server exact-limit, UTF-8, misleading Content-Length and streamed-body behavior remains covered. Compact edits of legacy records with large stored examples still work. Oversized replacements remain rejected by the accepted contract.

The separate-process recovery harness failure was previously reproduced on the untouched baseline. Per the user's decision it is a documented baseline issue, not a P1 regression or release blocker. That test and recovery implementation were left unchanged and not reinvestigated. The new focused matrix does not include that known failing restart case; actual proxy capability recovery is exercised in the 20 mock-paid cases.

## Test evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Focused P1 and existing regressions | **239/239**, 29 files | `test-results.json`, `test-evidence/p1-tests-final.log` |
| P1-specific subset | **43/43**, including 20 paid-proxy cases | `test-evidence/p1-focused-results.json` |
| Safe mock-provider paid flows | **20/20**, both paid entrances | `tests/provider-auth/paid.test.ts` results in the matrix |
| Styled Chromium Seller flows | **9/9** auth variants; **6/6** body-limit scenarios | `test-evidence/browser-results.json`, `p1-browser-final.log`, screenshots |
| Migration compatibility | **31 checks passed** after **53** prior migrations | `test-evidence/p1-postgres-final.log` |
| Node 24 default production build | **PASS**, Turbopack, TypeScript and static generation | `test-evidence/p1-node24-build-final.log` |
| Actual production Next runtime | **PASS**, Seller gate renders; anonymous Create returns 401; removed P2 routes/page return 404; no page errors | `test-evidence/runtime-smoke.json`, `p1-runtime-smoke-final.log` |
| Preservation/scope | Combined backup/worktree unchanged; 53 previous migrations and protected files unchanged | `test-evidence/p1-scope-integrity.json` |

The 43 P1 checks comprise 15 static authentication tests, 20 mock-paid tests, 5 server size/compatibility tests, 2 separation/rejection tests and 1 client request-size test. Existing regression coverage includes Seller creation/edit/verification/session and sensitive-proof behavior, request contracts, response/credential handling, x402 settlement/integration/errors/delivery and the MCP paid proxy.

Paid mocks cover public, legacy API-key/Bearer/query credentials, Basic, a custom key header, Token and ApiKey schemes, multiple headers plus Bearer, and headers plus Basic. Each runs on both entrances with actual proxy/delivery persistence and capability-only recovery, asserting one synthetic settlement and no second upstream dispatch on replay. No synthetic proof is submitted to a network.

Browser flows use the actual React components/styles and real HTTP requests to actual Seller handlers. Synthetic wallet UI/session, backing storage, AI and provider boundaries are fixtures; operation proofs are validated by the actual server code. The nine variants include all legacy modes, Basic, custom headers, Token, ApiKey and multiple headers plus Bearer. Six size scenarios cover analysis preflight, Create preflight, Create 413, Edit UTF-8 preflight before proof, Edit 413 and recovery after reduction. They assert draft retention and no mutation/request on local rejection. This does not claim real wallet-extension or provider-account certification.

## Migration and compatibility assessment

The SQL runs only against a newly initialized disposable PostgreSQL cluster using a Unix socket with no TCP listener or database URL. All 53 baseline migrations apply first. Tests verify unique/new version ordering, transactional rollback, preservation of populated legacy listing credentials and synthetic purchase/credit rows, unchanged existing functions/ACLs, columns/defaults/RLS, indexes/policies/triggers and other constraints. All seven static types work; OAuth and unknown types remain rejected. P2 database objects are absent.

The schema change is additive for existing valid listings. The existing encrypted-key format is unchanged and old/large credentials remain covered by P1 route tests. Owner/public projections do not return stored bundles. Reflection/injection/reserved-header protections pass their existing focused tests; no new critical/high P1 defect was confirmed. Provider limits remain the documented controlled schemes, printable-ASCII headers, eight custom headers/16-KiB wire cap and UTF-8 Basic.

No financial algorithm was changed. Both paid entrance files, settlement/Gateway/Arc/withdrawal/bridge financial files, dependencies and build config are byte-identical to baseline. Scope evidence lists the exact protected paths. New database writes are still subject to existing owner/session/proof and verification guards.

## Release disposition

P1 is independently deployable with **its constraint-only migration**, without installing or enabling any P2 work. The 64 KiB policy and baseline recovery issue no longer block P1 because the user supplied explicit dispositions and the UI behavior is tested. There are **no remaining P1 code or validation blockers** in this scope.

Production actions remain unapproved and unperformed. A release operator must approve and schedule migration-first/application-second execution; the CHECK alteration still takes a database lock, and Production-specific drift/timing were not measured. Rollback of the application must make new-mode listings unavailable before returning to an old runtime. No automatic migration, deploy, down migration or financial action follows this report.

The new backup contains P1 source/tests, patch, manifest, guide, this report, local worklog and test evidence. Its checksums and patch applicability/round-trip against a fresh exact baseline are verified separately. It references the preserved P2 backup rather than packaging P2 source into the P1 artifact. Stop for approval.
