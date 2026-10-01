-- Stores used withdrawal auth nonces to prevent signature replay attacks.
-- The service role (used by all /api routes) bypasses RLS and retains full access.
-- Anon and authenticated roles get zero access — nonces are server-only.
CREATE TABLE IF NOT EXISTS withdraw_used_nonces (
  nonce         text        PRIMARY KEY,
  seller_wallet text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.withdraw_used_nonces ENABLE ROW LEVEL SECURITY;
