# Provider authentication — P1 independent release

P1 adds HTTP Basic, custom API-key headers, controlled Authorization schemes and multiple encrypted credentials to the existing public/API-key/Bearer/query modes. OAuth P2 is excluded from this candidate, including its routes, UI, types, provider configuration and database objects. The complete P2 implementation remains in the verified combined backup for a later release.

The supported `auth_type` values are `public`, `apikey`, `bearer`, `queryparam`, `basic`, `headers` and `authorization`. Existing credential representations are unchanged. New bundles are JSON text supplied in `auth_key` and encrypted as a whole in the existing AES-GCM `encrypted_key` field. Owner reads expose only `credential_configured`; stored credentials are never returned to the editor, catalog or buyer. Leave the Edit credential blank to retain it, or replace the entire bundle.

Examples below are placeholders, not real provider credentials:

```json
{"username":"token-id","password":"secret"}
```

Use that bundle with `basic`. Basic encodes UTF-8 before Base64, allows one empty component, rejects colons in the username and rejects control characters. Providers requiring another charset are outside this implementation.

```json
{"headers":[{"name":"X-Provider-Key","value":"secret"}]}
```

Use `headers` for custom API-key names and multiple credentials:

```json
{"headers":[{"name":"X-Client-ID","value":"identifier"},{"name":"X-Client-Secret","value":"secret"}],"authorization":{"scheme":"Bearer","token":"token"}}
```

One to eight distinct custom credential headers are allowed. Header names are at most 64 characters, start with an ASCII letter, and may contain letters, digits, hyphens, underscores or dots. Values must be printable ASCII, at most 4,096 characters each. Reserved transport, cookie, forwarding, payment and platform headers are rejected, including normalized aliases. The complete credential header set is at most 16 KiB. Buyer-provided headers are never forwarded.

Optional combined Authorization supports `Basic` (username/password), `Bearer`, `Token` or `ApiKey` (token). Standalone `authorization` permits only `Token` and `ApiKey`; use the existing `bearer` or new `basic` mode for those standalone schemes:

```json
{"scheme":"Token","token":"secret"}
```

Unknown bundle properties, injection, malformed Unicode, duplicates and unsupported schemes fail validation. Create, Edit, analysis, verification and resource delivery use the same static credential resolver. Configuration changes retain the existing fresh owner-operation proof requirement and clear verification/activation. The financial settlement and recovery implementations are unchanged.

Known credential components and wire/JSON/URL/Base64 representations are checked for upstream reflection before output, AI analysis and persistence. This conservative filter can reject short identifiers echoed by providers and does not recognize arbitrary transformations. Do not put secrets in public descriptions, examples or schemas.

## Accepted request-size contract

Create, Edit and analysis use the same 64 KiB UTF-8 serialized-body ceiling. The user accepted this restriction for the P1 release. The UI displays the limit and checks the full serialized request before sending it or invoking the sensitive-request wallet proof flow. Oversized requests and server/edge 413 responses show a clear reduction instruction and retain the draft, including replacement credentials. Reducing the examples/metadata allows the same draft to be saved. Server-side byte/stream limits remain authoritative.

Compact edits to legacy listings containing large examples still work. Replacing an example or sending combined metadata above the ceiling returns 413. An older unbounded Edit client must respect the accepted limit.

## Independent migration and rollout

The sole P1 migration is `20261023091900_provider_authentication_p1.sql`, created with the installed CLI. It widens only `api_listings_auth_type_check` to the seven static modes. It creates no columns, tables, functions, triggers or OAuth objects, and changes no existing credentials, financial data or permissions. It was tested after all 53 canonical baseline migrations.

After separate Production approval, the required sequence is the P1-only migration followed by this P1 application artifact. The additive constraint accepts all existing modes during that interval. Do not apply the old combined migration as part of this release. No migration or deployment is performed by these instructions. Production lock duration and private schema drift were not measured locally.

An old application does not support new P1 auth types. An application rollback must first make those new-mode listings unavailable; retain the additive schema rather than dropping types while rows use them. No automatic down migration or listing mutation is supplied.

The preserved combined P1/P2 backup is `backup/provider-auth-P1-P2-20261023T091105Z-ss05b9pn`; its worktree remains unchanged. Later P2 work must be rebased onto this P1 candidate and use a new forward migration after the P1 version to add its two types and private objects. Do not replay the old combined patch or back-date its migration into P1 history. This is future integration work, not a reason to ship dormant P2 in P1.

See [the P1 readiness report](provider-authentication-audit.md) for the exact evidence and release decision.
