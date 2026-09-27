# Sessionless marketplace wallet authorization

Mahshar does not create a marketplace login or reusable wallet session. Connecting
a wallet identifies the address used for public, address-indexed reads. Read-only
dashboard, listing, earnings, balance, and safe activity views do not request a
signature.

## Protected operations

Seller mutations and sensitive response retrieval use one EIP-712 signature for
the exact HTTP operation. The signed structure binds the wallet, fixed Mahshar
application and Arc Mainnet context, HTTP method and route, canonical request
payload hash, random 256-bit nonce, issue time, and five-minute deadline.

The browser sends the proof in the x-mahshar-authorization header. The server
reconstructs the operation and payload hash from the actual request. It verifies
EOA signatures locally, with Arc Mainnet EIP-1271 verification as the contract
wallet fallback. Wallet changes during signing are rejected before submission.

After signature verification, the server inserts the nonce into the existing
server-only withdraw_used_nonces table. Its primary key is the atomic replay
barrier. The nonce is consumed before the handler executes, so any retry needs a
fresh authorization. No database migration is needed.

Listing handlers load the persisted resource and compare its seller wallet with
the recovered signer. Supplied wallet fields are consistency checks only.
Creation derives ownership from the signer. Existing credential verification and
deactivation fences remain in place.

Seller withdrawal and recovery retain their existing amount or withdrawal
specific EIP-191 messages, timestamp checks, signer verification, one-time nonce
consumption, and ownership checks. Sensitive last-response retrieval uses the
one-time EIP-712 request proof. x402 payment, Circle settlement, Bridge, and
Deposit paths are unchanged.

## Removed infrastructure

The Marketplace SIWE provider, challenge/session endpoints, opaque cookies,
24-hour session client, logout flow, and pending marketplace-auth migration were
removed. Bridge-specific archived SIWE material is unrelated and remains outside
this marketplace architecture.

## Verification

Run node --import tsx --import ./tests/marketplace/register.mjs tests/marketplace/run.mjs,
then the wallet-switch and withdrawal test files with their adjacent register
modules. They use synthetic wallets and in-memory boundaries without production
access. Together they cover payload binding, replay, expiry, origin, ownership,
public reads, sensitive response authorization, wallet changes during signing,
and withdrawal-specific signature and nonce protection.
