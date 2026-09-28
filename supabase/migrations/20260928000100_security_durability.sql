-- Forward-only security and durability hardening.
-- Historical rows are never assigned guessed purchase or delivery identities.

ALTER TABLE public.api_listings
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'GET',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS expected_status_codes integer[],
  ADD COLUMN IF NOT EXISTS consecutive_transient_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.api_calls
  ADD COLUMN IF NOT EXISTS is_client_error boolean,
  ADD COLUMN IF NOT EXISTS is_declared_expected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS response_body jsonb,
  ADD COLUMN IF NOT EXISTS purchase_id uuid REFERENCES public.purchases(id),
  ADD COLUMN IF NOT EXISTS delivery_attempt_id uuid REFERENCES public.x402_settlement_attempts(id),
  ADD COLUMN IF NOT EXISTS response_expires_at timestamptz;

UPDATE public.api_calls
SET response_expires_at = created_at + interval '7 days'
WHERE response_body IS NOT NULL AND response_expires_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS api_calls_one_recoverable_response_per_purchase
  ON public.api_calls(purchase_id)
  WHERE purchase_id IS NOT NULL AND success AND response_body IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_calls_purchase_lookup
  ON public.api_calls(purchase_id, api_id, buyer_wallet)
  WHERE response_body IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_calls_response_expiry
  ON public.api_calls(response_expires_at)
  WHERE response_body IS NOT NULL;

CREATE OR REPLACE FUNCTION public.mahshar_expected_status_codes_valid(p_codes integer[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p_codes IS NULL OR NOT EXISTS (
    SELECT 1 FROM unnest(p_codes) AS code
    WHERE code < 300 OR code > 599 OR code IN (408, 429) OR code >= 500
  )
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='api_listings_expected_status_codes_safe'
      AND conrelid='public.api_listings'::regclass
  ) THEN
    ALTER TABLE public.api_listings
      ADD CONSTRAINT api_listings_expected_status_codes_safe
      CHECK (public.mahshar_expected_status_codes_valid(expected_status_codes)) NOT VALID;
  END IF;
END $$;

-- Existing configuration must not retain exemptions that can hide transient
-- infrastructure failures. Keep only legitimate application-level statuses.
UPDATE public.api_listings
SET expected_status_codes = nullif(ARRAY(
  SELECT DISTINCT code
  FROM unnest(expected_status_codes) AS code
  WHERE code BETWEEN 300 AND 499 AND code NOT IN (408, 429)
  ORDER BY code
), '{}'::integer[])
WHERE NOT public.mahshar_expected_status_codes_valid(expected_status_codes);

ALTER TABLE public.api_listings
  VALIDATE CONSTRAINT api_listings_expected_status_codes_safe;

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

  -- Serializes even when the seller has no previous withdrawal row.
  PERFORM pg_advisory_xact_lock(hashtextextended('mahshar-withdraw:' || wallet, 0));

  IF EXISTS (
    SELECT 1 FROM public.seller_withdrawals
    WHERE lower(seller_wallet)=wallet
      AND status IN ('pending_mint','minted','failed')
      AND created_at >= clock_timestamp()-interval '60 seconds'
  ) THEN RAISE EXCEPTION 'withdrawal cooldown'; END IF;

  SELECT coalesce(sum(p.seller_share_usdc), 0) INTO earned
  FROM public.purchases p
  JOIN public.api_listings a ON a.id=p.api_id
  WHERE lower(a.seller_wallet)=wallet AND p.seller_share_usdc IS NOT NULL;

  SELECT coalesce(sum(amount_usdc), 0) INTO consumed
  FROM public.seller_withdrawals
  WHERE lower(seller_wallet)=wallet AND status IN ('pending_mint','minted','failed');

  available := earned-consumed;
  IF p_amount_usdc > available THEN
    RAISE EXCEPTION 'insufficient withdrawal balance';
  END IF;

  -- A minimal durable reservation is created before any Circle/RPC operation.
  -- The route replaces the placeholder accounting and burn intent before
  -- submitting the intent to Circle.
  INSERT INTO public.seller_withdrawals(
    seller_wallet,network_id,amount_usdc,net_amount_usdc,gas_cost_usdc,burn_intent,status
  ) VALUES(wallet,p_network_id,p_amount_usdc,p_amount_usdc,0,'{}'::jsonb,'pending_mint')
  RETURNING * INTO reserved;
  RETURN reserved;
END $$;

CREATE OR REPLACE FUNCTION public.topup_credits_atomic(p_wallet text, p_amount numeric)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE new_balance numeric;
BEGIN
  IF p_wallet !~ '^0x[0-9a-f]{40}$' OR p_amount IS NULL OR p_amount <= 0
  THEN RAISE EXCEPTION 'invalid credit topup'; END IF;
  INSERT INTO public.credit_balances(buyer_wallet,balance_usdc,updated_at)
    VALUES(lower(p_wallet),p_amount,now())
    ON CONFLICT(buyer_wallet) DO UPDATE
      SET balance_usdc=public.credit_balances.balance_usdc+excluded.balance_usdc,
          updated_at=now()
    RETURNING balance_usdc INTO new_balance;
  RETURN json_build_object('ok',true,'balance_usdc',new_balance);
END $$;

CREATE OR REPLACE FUNCTION public.deduct_credits_and_record_purchase(
  p_wallet text, p_amount numeric, p_api_id uuid, p_tx_hash text
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE new_balance numeric; purchase_id uuid;
BEGIN
  IF p_wallet !~ '^0x[0-9a-f]{40}$' OR p_amount IS NULL OR p_amount <= 0
    OR p_api_id IS NULL OR nullif(btrim(p_tx_hash),'') IS NULL OR length(p_tx_hash)>512
  THEN RAISE EXCEPTION 'invalid credit purchase'; END IF;
  UPDATE public.credit_balances
    SET balance_usdc=balance_usdc-p_amount,updated_at=now()
    WHERE buyer_wallet=lower(p_wallet) AND balance_usdc>=p_amount
    RETURNING balance_usdc INTO new_balance;
  IF NOT FOUND THEN
    RETURN json_build_object('ok',false,'balance_usdc',coalesce((
      SELECT balance_usdc FROM public.credit_balances WHERE buyer_wallet=lower(p_wallet)
    ),0));
  END IF;
  INSERT INTO public.purchases(buyer_wallet,api_id,amount_usdc,tx_hash)
    VALUES(lower(p_wallet),p_api_id,p_amount,p_tx_hash)
    RETURNING id INTO purchase_id;
  RETURN json_build_object('ok',true,'balance_usdc',new_balance,'purchase_id',purchase_id);
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_prune_api_call_responses(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE affected integer;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'invalid prune limit'; END IF;
  WITH expired AS (
    SELECT id FROM public.api_calls
    WHERE response_body IS NOT NULL AND response_expires_at <= now()
    ORDER BY response_expires_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.api_calls calls SET response_body=NULL
  FROM expired WHERE calls.id=expired.id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_expected_status_codes_valid(integer[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mahshar_reserve_seller_withdrawal(text,numeric,text),
  public.topup_credits_atomic(text,numeric),
  public.deduct_credits_and_record_purchase(text,numeric,uuid,text),
  public.mahshar_prune_api_call_responses(integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_reserve_seller_withdrawal(text,numeric,text),
  public.mahshar_expected_status_codes_valid(integer[]),
  public.topup_credits_atomic(text,numeric),
  public.deduct_credits_and_record_purchase(text,numeric,uuid,text),
  public.mahshar_prune_api_call_responses(integer)
  TO service_role;
