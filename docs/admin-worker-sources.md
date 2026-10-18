# Admin Worker discovery sources

This release configures five discovery adapters in the existing Admin Worker. Both additive source-expansion and email-identity migrations are installed in Production (48 migrations). Access evidence was checked on October 18, 2026. ACTIVE-READY describes an available adapter for a future authorized Worker Start, not a running Worker or permission to send outreach.

| Source | Status | Supported access and remaining requirement |
| --- | --- | --- |
| RapidAPI | PERMISSION-GATED | [Terms](https://rapidapi.com/page/terms). An approved catalog API/export and permission for this commercial use are required. No internal GraphQL, session extraction or website scraping is implemented. |
| Postman API Network | CREDENTIAL-GATED | The [official Postman API](https://learning.postman.com/docs/developer/intro-api/) requires a key and an approved workspace/collection scope. Its account APIs are not a verified global Network export. No key alone activates discovery. |
| Zyla API Hub | PERMISSION-GATED | [Terms](https://zylalabs.com/terms) and the [official MCP guide](https://appexchange.zylalabs.com/agents/setup). Catalog tools exist, but commercial provider-discovery permission and a suitable key/scope remain necessary. Execution may create subscriptions; it is never invoked. |
| APILayer Marketplace | PERMISSION-GATED | The [marketplace](https://marketplace.apilayer.com/) documents product APIs, not an approved reusable catalog export for this integration. Obtain that interface and permission first. |
| API.market | UNSUPPORTED | [Official documentation](https://docs.api.market/) describes product, seller and usage APIs. No supported global catalog contract was verified. No undocumented requests are implemented. |
| Apify Store | ACTIVE-READY | [Unauthenticated Store API](https://docs.apify.com/api/v2/store) and [public user profiles](https://docs.apify.com/api/v2/user-get). Only catalog/profile GETs are implemented. An Actor is a tool, not proof of a commercial API. Profiles without a usable external HTTPS website yield no provider candidate. |
| AllThingsDev | UNSUPPORTED | [Official getting-started documentation](https://www.allthingsdev.co/documentation/getting-started) describes marketplace use. A supported automated catalog contract was not verified. |
| ApyHub | PERMISSION-GATED | Its [catalog](https://apyhub.com/catalog) is primarily utility APIs. Obtain approved catalog-only access and reuse permission; utility/MCP execution credentials do not establish it. |
| APIs.io | PERMISSION-GATED | [Terms](https://apis.io/terms) restrict substantial replication. Mahshar's intended use needs written clearance, plus any approved plan/key. No repository or API route bypass is implemented. |
| API Tracker | PERMISSION-GATED | The [official directory](https://apitracker.io/) advertises an agent view. A reusable bulk provider feed and permission for this use remain unverified. No profile crawler is implemented. |
| APIDirectory | PERMISSION-GATED | [Dataset page](https://apidirectory.com/data) and [terms](https://apidirectory.com/terms) distinguish free developer/sample access from licensed commercial exports. Commercial license and credentials remain necessary. |
| APIs.guru | ACTIVE-READY | Existing [public REST catalog](https://api.apis.guru/v2/providers.json), detail parsing and pre-upgrade batch compatibility remain unchanged. |
| Public APIs (publicapis.dev) | ACTIVE-READY | The site's [terms](https://publicapis.dev/terms) direct data users to its [MIT repository](https://github.com/marcelscruz/public-apis). Fetch its Markdown dataset, not the website. Notice retained in `docs/licenses/publicapis-dev.txt`. |
| GitHub Public APIs | ACTIVE-READY | [MIT repository](https://github.com/public-apis/public-apis). Bounded raw Markdown download; notice retained in `docs/licenses/github-public-apis.txt`. |
| Public API Lists | ACTIVE-READY | Existing [MIT JSON dataset](https://github.com/public-api-lists/public-api-lists). Existing attribution and access behavior remain intact. |

Ten sources have no runtime transport. Their typed registrations record the access blocker without pretending they are operational. All five implemented adapters use the existing Worker, shared discovery dispatcher and existing qualification/contact pipeline. No paid marketplace API, Actor, MCP execution tool, subscription, rental, provider import or email transport is added.

## Progress, fairness and cost control

Each new logical batch persists its enabled source plan. The first source rotates with the root run number, and subsequent observations rotate fairly. Resume retains its original source plan, including two-source plans created by the deployed Phase 1 application. Finalized domains and established aliases use the existing permanent provider history. Names alone never merge providers.

The two new Markdown adapters retain compact normalized observations without emails, ownership claims or purported contracts. Catalogs use the existing 24-hour cache and content revisions. Apify uses bounded 20-record pages, a persisted next-page offset, and explicit public-profile reads to identify candidate domains. Marketplace domains and unrelated/shared-host URLs cannot identify the underlying provider. Missing profile websites do not create an invented identity. Dynamic offset catalogs can shift as upstream records change; after a completed sweep, a later cache refresh revisits the catalog with existing durable history protecting finalized providers.

The source cursor advances atomically with immutable source work and durable candidate storage. Existing bounded recovery preserves accepted but unfinished observations across target completion, Stop, deadlines, budget limits and interrupted checkpoints. Source failures and request caps pause that source while healthy sources continue. Shared database failures still fail closed.

Every actual HTTP attempt, including redirects and uncertain retries, needs a fresh charge. A new service-only RPC uses the existing run lock and budget ledger to cap each source at 40 requests per logical batch, including Resume. The existing global source, research, Groq and contact limits remain enforced. Replayed claims never authorize another request. Catalog operations have no execution fees; qualification retains its existing Groq allowance. Cheap profile/source observations are distinct from repeated research or inference.

## Provider and recipient identity

All sources retain existing normalized provider/product identities, alias checks, durable research cooldowns and provider-level invitation history. The existing ownership, documentation, OpenAPI, Groq, verified-contact and suppression gates remain mandatory. An Actor record, README table or directory link satisfies none of those gates by itself.

The registry enforces provider uniqueness and a normalized-email unique index for pending/manual-sent recipients, with cross-provider checks against verified contacts and manual, contacted, Outreach, Acquisition and legacy email history. Shared-email identities are held for manual review through an ineligible `email_identity_conflict` result; their separate provider/contact evidence is retained. They are never automatically merged. Direct conflicting registry writes are excluded, and concurrent claims are fenced. Busy email claims skip insertion without a terminal exclusion, so existing reconciliation can recover them later. The Pending Emails UI and manual-sent history are unchanged.

## Schema requirements

These separately approved migrations are installed in Production. New installations require both, in order, before application deployment:

- `20261018000200_admin_worker_source_expansion.sql`: expands attribution IDs, adds only the three approved source-state rows, and adds the service-only source request-cap RPC using existing storage.
- `20261018000300_admin_worker_email_identity_guard.sql`: adds normalized-recipient indexes, history/conflict checks and a registry guard. It changes only the existing eligibility function's additional email check. Existing normalized-email collisions cause the migration to abort for review; no records are silently rewritten or merged.

The second migration exposes a service-only readiness probe. The application checks it before reconciliation, candidate processing or external requests, preventing a partial schema rollout from bypassing the new protection. Previously applied migration files remain unchanged. Deployment order is separate migration review/preflight, both additive migrations, verification, then an independently authorized application release. Worker activation and any email delivery require their existing separate authorization.
