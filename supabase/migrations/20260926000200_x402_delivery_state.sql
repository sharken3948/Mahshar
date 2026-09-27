-- Delivery is tracked separately from settlement/accounting. This migration is
-- additive and does not rewrite historical purchases. Existing attempts are
-- conservatively marked UNKNOWN because their upstream side effect may already
-- have happened before delivery tracking existed.
ALTER TABLE public.x402_settlement_attempts
  ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (delivery_state IN ('NOT_STARTED','IN_PROGRESS','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS delivery_request_hash text CHECK (delivery_request_hash IS NULL OR delivery_request_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS delivery_token uuid,
  ADD COLUMN IF NOT EXISTS delivery_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_http_status integer CHECK (delivery_http_status IS NULL OR delivery_http_status BETWEEN 100 AND 599),
  ADD COLUMN IF NOT EXISTS delivery_error_code text CHECK (delivery_error_code IS NULL OR delivery_error_code ~ '^[a-z0-9_]{1,80}$');

ALTER TABLE public.x402_settlement_attempts ALTER COLUMN delivery_state SET DEFAULT 'NOT_STARTED';

CREATE INDEX IF NOT EXISTS x402_attempts_incomplete_delivery
  ON public.x402_settlement_attempts(updated_at)
  WHERE state='ACCOUNTING_COMPLETE' AND delivery_state NOT IN ('SUCCEEDED','FAILED_FINAL','UNKNOWN');

CREATE OR REPLACE FUNCTION public.x402_delivery_claim(p_id uuid, p_token uuid, p_request_hash text)
RETURNS public.x402_settlement_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.x402_settlement_attempts;
BEGIN
  IF p_token IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid delivery claim';
  END IF;
  SELECT * INTO STRICT a FROM public.x402_settlement_attempts WHERE id=p_id FOR UPDATE;
  IF a.state <> 'ACCOUNTING_COMPLETE' THEN RAISE EXCEPTION 'accounting incomplete'; END IF;

  -- A worker that disappears after acquiring the lease may already have sent
  -- the upstream request. Mark it unknown; never automatically run it again.
  IF a.delivery_state='IN_PROGRESS' AND a.delivery_started_at < now()-interval '2 minutes' THEN
    UPDATE public.x402_settlement_attempts
      SET delivery_state='UNKNOWN', delivery_error_code='delivery_worker_interrupted',
          delivery_completed_at=now(), updated_at=now()
      WHERE id=p_id RETURNING * INTO a;
    RETURN a;
  END IF;

  IF a.delivery_request_hash IS NOT NULL AND a.delivery_request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'delivery request mismatch';
  END IF;
  IF a.delivery_state IN ('NOT_STARTED','FAILED_RETRYABLE') THEN
    UPDATE public.x402_settlement_attempts
      SET delivery_state='IN_PROGRESS', delivery_request_hash=p_request_hash,
          delivery_token=p_token, delivery_started_at=now(), delivery_completed_at=NULL,
          delivery_http_status=NULL, delivery_error_code=NULL, updated_at=now()
      WHERE id=p_id RETURNING * INTO a;
  END IF;
  RETURN a;
END $$;

CREATE OR REPLACE FUNCTION public.x402_delivery_complete(
  p_id uuid, p_token uuid, p_state text, p_http_status integer, p_error_code text
) RETURNS public.x402_settlement_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.x402_settlement_attempts;
BEGIN
  IF p_state NOT IN ('SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL','UNKNOWN')
    OR p_http_status NOT BETWEEN 100 AND 599
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,80}$')
  THEN RAISE EXCEPTION 'invalid delivery completion'; END IF;
  SELECT * INTO STRICT a FROM public.x402_settlement_attempts WHERE id=p_id FOR UPDATE;
  IF a.delivery_state <> 'IN_PROGRESS' OR a.delivery_token IS DISTINCT FROM p_token THEN
    RAISE EXCEPTION 'delivery completion conflict';
  END IF;
  UPDATE public.x402_settlement_attempts
    SET delivery_state=p_state, delivery_http_status=p_http_status,
        delivery_error_code=p_error_code, delivery_completed_at=now(), updated_at=now()
    WHERE id=p_id RETURNING * INTO a;
  RETURN a;
END $$;

REVOKE ALL ON FUNCTION public.x402_delivery_claim(uuid,uuid,text),
  public.x402_delivery_complete(uuid,uuid,text,integer,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.x402_delivery_claim(uuid,uuid,text),
  public.x402_delivery_complete(uuid,uuid,text,integer,text)
  TO service_role;
