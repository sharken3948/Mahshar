-- Forward-only follow-up for ambiguous seller withdrawals and independent
-- rate-limit buckets. Historical migrations remain unchanged.

ALTER TABLE public.seller_withdrawals
  ADD COLUMN IF NOT EXISTS gateway_transfer_id text,
  ADD COLUMN IF NOT EXISTS gateway_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE public.seller_withdrawals
  DROP CONSTRAINT IF EXISTS seller_withdrawals_status_check;
ALTER TABLE public.seller_withdrawals
  ADD CONSTRAINT seller_withdrawals_status_check
  CHECK (status IN (
    'pending_mint', 'submission_unknown', 'mint_unknown',
    'minted', 'expired', 'failed'
  ));
ALTER TABLE public.seller_withdrawals
  ADD CONSTRAINT seller_withdrawals_gateway_transfer_id_length
  CHECK (gateway_transfer_id IS NULL OR length(gateway_transfer_id) BETWEEN 1 AND 512),
  ADD CONSTRAINT seller_withdrawals_last_error_length
  CHECK (last_error IS NULL OR length(last_error) <= 2048);

CREATE UNIQUE INDEX IF NOT EXISTS seller_withdrawals_gateway_transfer_id_unique
  ON public.seller_withdrawals(gateway_transfer_id)
  WHERE gateway_transfer_id IS NOT NULL;

DROP INDEX IF EXISTS public.uniq_seller_withdrawals_pending_mint;
CREATE UNIQUE INDEX uniq_seller_withdrawals_in_flight
  ON public.seller_withdrawals(lower(seller_wallet))
  WHERE status IN ('pending_mint', 'submission_unknown', 'mint_unknown');

CREATE OR REPLACE FUNCTION public.mahshar_reserve_seller_withdrawal(
  p_seller_wallet text,
  p_amount_usdc numeric,
  p_network_id text
) RETURNS public.seller_withdrawals
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  wallet text := lower(btrim(p_seller_wallet));
  earned numeric;
  consumed numeric;
  available numeric;
  reserved public.seller_withdrawals;
BEGIN
  IF wallet !~ '^0x[0-9a-f]{40}$' OR wallet = '0x0000000000000000000000000000000000000000'
    OR p_network_id <> 'eip155:5042'
    OR p_amount_usdc IS NULL OR p_amount_usdc < 1
    OR p_amount_usdc <> trunc(p_amount_usdc, 6)
  THEN RAISE EXCEPTION 'invalid withdrawal reservation'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('mahshar-withdraw:' || wallet, 0));

  IF EXISTS (
    SELECT 1 FROM public.seller_withdrawals
    WHERE lower(seller_wallet)=wallet
      AND status IN ('pending_mint','submission_unknown','mint_unknown','minted','failed')
      AND created_at >= clock_timestamp()-interval '60 seconds'
  ) THEN RAISE EXCEPTION 'withdrawal cooldown'; END IF;

  SELECT coalesce(sum(p.seller_share_usdc), 0) INTO earned
  FROM public.purchases p
  JOIN public.api_listings a ON a.id=p.api_id
  WHERE lower(a.seller_wallet)=wallet AND p.seller_share_usdc IS NOT NULL;

  SELECT coalesce(sum(amount_usdc), 0) INTO consumed
  FROM public.seller_withdrawals
  WHERE lower(seller_wallet)=wallet
    AND status IN ('pending_mint','submission_unknown','mint_unknown','minted','failed');

  available := earned-consumed;
  IF p_amount_usdc > available THEN
    RAISE EXCEPTION 'insufficient withdrawal balance';
  END IF;

  INSERT INTO public.seller_withdrawals(
    seller_wallet,network_id,amount_usdc,net_amount_usdc,gas_cost_usdc,burn_intent,status
  ) VALUES(wallet,p_network_id,p_amount_usdc,p_amount_usdc,0,'{}'::jsonb,'pending_mint')
  RETURNING * INTO reserved;
  RETURN reserved;
END $$;

-- Consume wallet and IP buckets in one database round trip. Each constituent
-- bucket is still independently incremented and must allow the request.
CREATE OR REPLACE FUNCTION public.mahshar_take_rate_limits(p_buckets jsonb)
RETURNS TABLE(allowed boolean, remaining integer, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  item jsonb;
  bucket_result record;
  all_allowed boolean := true;
  min_remaining integer := 10000;
  max_retry integer := 0;
  bucket_count integer;
BEGIN
  IF jsonb_typeof(p_buckets) <> 'array' THEN
    RAISE EXCEPTION 'invalid rate limit buckets';
  END IF;
  bucket_count := jsonb_array_length(p_buckets);
  IF bucket_count < 1 OR bucket_count > 4 OR (
    SELECT count(DISTINCT value->>'key_hash') <> bucket_count
    FROM jsonb_array_elements(p_buckets)
  ) THEN RAISE EXCEPTION 'invalid rate limit buckets'; END IF;

  FOR item IN
    SELECT value FROM jsonb_array_elements(p_buckets)
    ORDER BY value->>'key_hash'
  LOOP
    IF jsonb_typeof(item) <> 'object'
      OR (item->>'key_hash') IS NULL
      OR (item->>'limit') IS NULL
      OR (item->>'window_seconds') IS NULL
      OR (item->>'limit') !~ '^[0-9]+$'
      OR (item->>'window_seconds') !~ '^[0-9]+$'
    THEN RAISE EXCEPTION 'invalid rate limit buckets'; END IF;

    SELECT * INTO bucket_result
    FROM public.mahshar_take_rate_limit(
      item->>'key_hash',
      (item->>'limit')::integer,
      (item->>'window_seconds')::integer
    );
    all_allowed := all_allowed AND bucket_result.allowed;
    min_remaining := least(min_remaining, bucket_result.remaining);
    max_retry := greatest(max_retry, bucket_result.retry_after_seconds);
  END LOOP;

  RETURN QUERY SELECT all_allowed, min_remaining, max_retry;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_take_rate_limits(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_take_rate_limits(jsonb) TO service_role;
