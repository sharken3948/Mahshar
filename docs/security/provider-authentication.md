# Provider authentication — Production status

Production supports the original public/API-key/Bearer/query modes and P1 HTTP Basic, custom API-key headers, controlled Authorization schemes and multiple encrypted credentials. P2 OAuth Client Credentials is deployed for operator-approved profiles. A real Production Bitbucket Client Credentials exchange and read-only resource request succeeded for a private, inactive test listing. Authorization Code + PKCE is implemented but disabled in Production. This status reflects the approved Production source at `95a42fcb7dd47af164f9fe0e37bec004e50bbc75` and verified provider testing; it does not certify every provider or a paid OAuth purchase.

The static `auth_type` values are `public`, `apikey`, `bearer`, `queryparam`, `basic`, `headers` and `authorization`. Existing credential representations are unchanged. New bundles are JSON text supplied in `auth_key` and encrypted as a whole in the existing AES-GCM `encrypted_key` field. Owner reads expose only `credential_configured`; stored credentials are never returned to the editor, catalog or buyer. Leave the Edit credential blank to retain it, or replace the entire bundle.

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

## P1 migration compatibility

The deployed P1 migration `20261023091900_provider_authentication_p1.sql` remains unchanged. All 54 migrations in the P1 baseline are preserved. The P1 credential representation, seven static types and accepted 64 KiB Create/Edit/analysis behavior above remain supported. Existing financial, settlement, Gateway, x402 and recovery implementations are retained.

## P2 OAuth Client Credentials

The deployed schema adds `oauth_client_credentials` and `oauth_pkce`, but only Client Credentials has an enabled Production profile. OAuth client configuration is an encrypted JSON bundle in `encrypted_key`. Access/refresh tokens and PKCE verifiers remain encrypted server-side in private tables. Sellers select an operator-approved profile, not arbitrary token endpoints or scopes. Client Credentials is seller-owned. PKCE code can support seller or buyer delegation if separately enabled; it is unavailable in Production. Public/owner listing responses expose configuration status, not stored credentials or tokens.

Seller OAuth drafts must be saved before connecting. Connect requires the existing fresh wallet operation proof. A connected provider account does not make its listing active or public: analysis, verification and publication remain separate actions. The disabled PKCE implementation uses state, S256, a five-minute expiry, HttpOnly browser binding, and wallet/session/configuration binding. Seller reconnect/configuration changes clear activation and verification. Disconnect clears local tokens and fences in-flight refresh/callback completion; remote revocation is best effort. Database leases serialize refresh and fail closed on uncertain rotation. There is no process-global token cache.

The P2 migration `20261023162226_provider_oauth_p2.sql` is installed in Production. It widens the P1 auth CHECK to nine types, adds two private RLS-enabled tables, service-role-only functions and a configuration invalidation trigger. The old combined migration `20261022000100_provider_authentication.sql` is deliberately absent. Migration compatibility was also tested after the complete P1 chain on disposable PostgreSQL 16 and 17.

Future profile activation requires separate provider and operational review. An application rollback must first make OAuth listings unavailable; retain the additive schema rather than dropping types/tables while in use. No automatic down migration is supplied.

See the [historical P2 readiness review](provider-authentication-audit.md) and [historical provider test preparation](provider-oauth-testing.md) for the pre-release test plan. Their original NO-GO findings are snapshots, not the current Production status.
