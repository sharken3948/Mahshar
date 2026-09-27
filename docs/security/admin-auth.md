# Sessionless admin wallet authorization

Admin routes use the same one-time EIP-712 request authorization as seller
mutations. There is no admin login, session endpoint, cookie, or reusable proof.
Every sensitive read and mutation is bound to its exact route, query or body,
nonce, signer, and deadline.

After cryptographic verification and nonce consumption, the server checks the
recovered wallet against the server-only ADMIN_WALLETS allowlist on every request.
Client wallet claims, x-admin-key, and public environment variables grant no
authority. Missing or malformed allowlist configuration fails closed.

Discovery listing mutations keep their existing source, configured seller,
credential verification, and field restrictions. The EIP-712 layer does not
replace those resource checks.

The admin layout only supplies the shared signed-request function. It has no
page-level verification dialog or authenticated UI session. Sensitive admin
requests open the connected wallet directly and each proof is single use.

No schema change is required. Tests use synthetic accounts and an in-memory
service boundary; no wallet, database, network, or deployment action occurs.
