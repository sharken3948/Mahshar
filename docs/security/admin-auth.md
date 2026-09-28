# Admin wallet session authorization

Admin routes use the same eight-hour database-backed wallet session as ordinary
private marketplace routes. After session validation, the normalized wallet is
checked against the server-only `ADMIN_WALLETS` allowlist on every request.
Client wallet claims, public environment variables, and legacy admin secrets
grant no authority. Missing or malformed allowlist configuration fails closed.

Admin mutations also require the exact canonical `MARKETPLACE_ORIGIN` and reject
cross-site Fetch Metadata. Resource/source, configured seller, credential, and
field restrictions remain independent authorization layers.

The shared client session provider prevents each admin read or mutation from
opening another signature request. Changing wallets causes a new login for that
wallet and another allowlist check; it never carries A's admin authority to B.
