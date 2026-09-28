-- Forward-only wallet login sessions. Browser cookies contain only an opaque
-- random token; the database stores its SHA-256 hash and the normalized wallet.

CREATE TABLE public.wallet_auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL CHECK (wallet = lower(wallet) AND wallet ~ '^0x[0-9a-f]{40}$'),
  nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '10 minutes')
);

CREATE TABLE public.wallet_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  wallet text NOT NULL CHECK (wallet = lower(wallet) AND wallet ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours')
);

CREATE INDEX wallet_auth_challenges_expiry ON public.wallet_auth_challenges(expires_at);
CREATE INDEX wallet_sessions_expiry ON public.wallet_sessions(expires_at);
CREATE INDEX wallet_sessions_wallet_active ON public.wallet_sessions(wallet, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.wallet_auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_auth_challenges, public.wallet_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wallet_auth_challenges, public.wallet_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.mahshar_prune_wallet_auth(p_limit integer DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE challenge_count integer; session_count integer;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'invalid prune limit'; END IF;
  WITH expired AS (
    SELECT id FROM public.wallet_auth_challenges
    WHERE expires_at <= now() OR (used_at IS NOT NULL AND used_at <= now()-interval '1 day')
    ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.wallet_auth_challenges challenges USING expired
  WHERE challenges.id=expired.id;
  GET DIAGNOSTICS challenge_count = ROW_COUNT;

  WITH expired AS (
    SELECT id FROM public.wallet_sessions
    WHERE expires_at <= now() OR (revoked_at IS NOT NULL AND revoked_at <= now()-interval '1 day')
    ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.wallet_sessions sessions USING expired
  WHERE sessions.id=expired.id;
  GET DIAGNOSTICS session_count = ROW_COUNT;

  RETURN jsonb_build_object('challenges',challenge_count,'sessions',session_count);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_prune_wallet_auth(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_prune_wallet_auth(integer) TO service_role;
