# P2 isolated provider test preparation — 2026-10-23

Status: implementation restored and mock-tested; real-provider tests are BLOCKED. No real OAuth application credentials, test-origin approval or consent approval were supplied. The profiles in `provider-oauth-test-profiles.json` are review templates, not installed configuration or proof of provider verification. Never paste actual credentials into this document, Git, logs or public listing examples.

## Client Credentials: Bitbucket Cloud

Use a legitimate operator-controlled Atlassian account, a dedicated test workspace and an otherwise empty private repository named `p2-auth-probe`. The Free plan supports up to five workspace users; avoid Pipelines, paid add-ons and upgrades. [Plan requirements](https://support.atlassian.com/bitbucket-cloud/docs/manage-your-plan-and-billing/).

As a workspace administrator, open Settings → Workspace settings → Apps and Features → OAuth consumers → Add consumer. Name it `Mahshar P2 isolated CC test`, set a legitimate approved HTTPS callback (registration requires one, this grant does not navigate there), and enable only Repositories: Read. Save its Key and Secret privately as `client_id` and `client_secret`. Do not enable account, email, write or admin permissions. [Consumer setup](https://support.atlassian.com/bitbucket-cloud/docs/integrate-another-application-through-oauth/).

The template uses `client_secret_basic`, `client_credentials`, scope `repository`, and token endpoint `https://bitbucket.org/site/oauth2/access_token`. The token represents the consumer owner. Resource requests use Bearer authentication at `api.bitbucket.org`, as required since May 4, 2026. Consumer permissions must be minimal; request scope is not a substitute for that restriction. Access tokens are documented as lasting one hour; this implementation reacquires a CC token rather than relying on refresh tokens. [Grant and API contract](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).

Proposed isolated Seller configuration: `oauth_client_credentials`, GET `https://api.bitbucket.org/2.0/repositories/<test-workspace>/p2-auth-probe`, no body, Utility category, inactive. Read only the dummy repository. Do not create a paid public listing during this task. [Repository API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/).

Private API Credential format (replace placeholders locally):

```json
{"provider":"bitbucket-test-cc","client_id":"<consumer-key>","client_secret":"<consumer-secret>","account_mode":"seller"}
```

## Authorization Code + PKCE: GitLab.com

Use legitimate dedicated GitLab Free identities: the Seller identity and two distinct buyer identities for isolation checks, with corresponding separate isolated wallet sessions. No repositories, CI minutes, card, paid plan or broad API/write permission is needed for the proposed profile probe. GitLab documents this OAuth API on its Free tier. [OAuth API](https://docs.gitlab.com/api/oauth2/).

The app owner opens avatar → Edit profile → Access → Applications → Add new application. Name it `Mahshar P2 isolated PKCE test`; enable only `read_user`. Register each exact callback required by the isolated listing IDs. Record the Application ID privately. [Application setup and scope meanings](https://docs.gitlab.com/integration/oauth_provider/).

Clear the Confidential checkbox for this public PKCE template (`client_auth: none`); omit `client_secret` from the Seller bundle. A confidential app requires a different matching operator profile and secret. [GitLab public-client authentication requirement](https://docs.gitlab.com/cli/authentication/#error-invalid_client-during-oauth-login).

The template fixes authorization/token/revocation to `https://gitlab.com/oauth/authorize`, `/oauth/token`, and `/oauth/revoke`. PKCE uses S256. GitLab's documented token lifetime is 7200 seconds, with rotating refresh tokens; refresh includes the same callback URI as consent. The recommended read-only probe is GET `https://gitlab.com/api/v4/user` with no body. [PKCE, refresh, revocation and Bearer API contracts](https://docs.gitlab.com/api/oauth2/).

Private API Credential format:

```json
{"provider":"gitlab-test-pkce","client_id":"<application-id>","account_mode":"seller"}
```

For a second isolated buyer-delegated listing use the same shape with `"account_mode":"buyer"`. Each wallet connects its own provider identity; a missing connection must never use the seller token. Keep responses containing profile data in private evidence and redact them from public examples.

## Exact local configuration prerequisites

1. Approve a stable, independent HTTPS staging origin and disposable database. This task creates neither a hosted environment nor provider apps. Keep Production unchanged.
2. Set the isolated server's `MARKETPLACE_ORIGIN` to that origin, its existing encryption/session/Supabase configuration to test-only values, and `PROVIDER_OAUTH_PROFILES` to the reviewed JSON array in `provider-oauth-test-profiles.json`. The registry is server-only; no `NEXT_PUBLIC_` variant. The current test/build default is an empty registry.
3. Apply the 54 P1 migrations then the single forward migration `20261023162226_provider_oauth_p2.sql` to that disposable environment only, under separate execution approval if hosted. Never replay the old combined migration.
4. Create inactive OAuth drafts through the authenticated Seller flow, retaining the returned listing IDs. Do not use direct database inserts. Register the literal URI `https://<approved-test-host>/api/provider-oauth/<actual-listing-UUID>/callback` for each PKCE draft; placeholders/wildcards are not usable callback registrations. Public endpoints/profiles contain no secrets.
5. Store credentials with owner-only permissions in an operator-chosen persistent private directory outside the repository. Supply them only to the isolated Seller form/server secrets. No real secrets have been generated or stored by this restoration.
6. Obtain explicit operator approval before clicking Connect provider, navigating to an actual authorization URL, granting consent, or acquiring real provider tokens. The mock browser consent links do not authorize real accounts.

## Approval-gated acceptance still required

- Bitbucket: real CC acquisition, dummy repository read, expiry/reacquisition, invalid-secret rejection, disconnect and reconnect. Confirm actual token fields/scopes and rate limits without recording tokens.
- GitLab: real consent allow/deny, exact callback registration, actual resource identity, expiry/rotating refresh, disconnect/revocation and reconnect. Verify provider behavior for public-client revocation; local disconnect remains effective even if remote revocation fails.
- Seller and two buyer sessions: independently prove that each provider resource identity matches the authorized wallet connection; reject wrong/missing sessions and payer mismatch using isolated mock settlement. No USDC transaction is required or approved.
- Plan expired-state pruning and provider removal/revocation operations before rollout. Expired state rows are rejected but are not automatically deleted on a schedule by this candidate.

The mock suite verifies the documented request shapes, concurrency, encryption and authorization boundaries. It cannot establish a real provider's account policy or certify these applications. No external OAuth token/resource call was made in this task. Spotify is not the preferred free alternative: its current Web API setup requires Premium. [Spotify setup](https://developer.spotify.com/documentation/web-api/tutorials/getting-started).

## Supported contract limits

Only fixed operator-approved HTTPS endpoints/origins/scopes are accepted. No arbitrary audience/resource extensions, client assertions, DPoP, mTLS, token exchange or form-post callback is implemented. Tokens must be Bearer, with numeric `expires_in` between 61 seconds and 31 days and a bounded 32 KiB token response. Unexpected returned `scope` values fail closed; providers using nonstandard `scopes` metadata still require review of the consumer's actual permissions. Revocation is best effort, and removing/changing a profile requires direct provider cleanup for former tokens. Use these constraints to screen providers; do not expand P2 merely to accommodate an unrelated provider.
