-- Additive, local preparation. No ledger backfill, ownership reclassification or transfer.
CREATE TABLE public.admin_gateway_commission_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  amount_usdc numeric(24,6) NOT NULL CHECK (amount_usdc > 0),
  mint_value_usdc numeric(24,6) NOT NULL CHECK (mint_value_usdc > 0),
  source_fee_cap_usdc numeric(24,6) NOT NULL CHECK (source_fee_cap_usdc > 0),
  destination_gas_estimate_usdc numeric(24,6) NOT NULL CHECK (destination_gas_estimate_usdc >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN
    ('reserved','preparing','submission_unknown','pending_mint','mint_unknown','minted','expired','failed')),
  burn_intent jsonb,
  attestation text,
  attestation_signature text,
  gateway_transfer_id text UNIQUE CHECK (gateway_transfer_id IS NULL OR length(gateway_transfer_id) BETWEEN 1 AND 512),
  gateway_submitted_at timestamptz,
  mint_tx_hash text UNIQUE,
  minted_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_usdc = mint_value_usdc + source_fee_cap_usdc)
);
CREATE UNIQUE INDEX admin_gateway_one_inflight_commission_withdrawal
  ON public.admin_gateway_commission_withdrawals ((true))
  WHERE status IN ('reserved','preparing','submission_unknown','pending_mint','mint_unknown');
ALTER TABLE public.admin_gateway_commission_withdrawals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_gateway_commission_withdrawals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.admin_gateway_commission_withdrawals TO service_role;

-- The same bounded formula as commissionAllowance. No inference of a new payable
-- share for pre-accumulation purchases (20260918_seller_withdrawals.sql).
CREATE FUNCTION public.mahshar_admin_commission_limits(p_gateway_available_usdc numeric)
RETURNS TABLE (accrued_usdc numeric, remaining_usdc numeric, seller_liabilities_usdc numeric,
  confirmed_seller_reserve_usdc numeric, reserved_usdc numeric, allowance_usdc numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  shares numeric;
  paid numeric;
  consumed numeric;
BEGIN
  IF p_gateway_available_usdc IS NULL OR p_gateway_available_usdc < 0
    OR p_gateway_available_usdc > 1000000000000000000
    OR p_gateway_available_usdc <> trunc(p_gateway_available_usdc,6) THEN
    RAISE EXCEPTION 'invalid Gateway balance';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchases WHERE seller_share_usdc IS NOT NULL AND
      (seller_share_usdc < 0 OR seller_share_usdc > amount_usdc OR
       seller_share_usdc <> trunc(seller_share_usdc,6))) THEN
    RAISE EXCEPTION 'invalid recorded seller share';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.x402_settlement_attempts a
    LEFT JOIN public.purchases p ON p.id=a.purchase_id
    WHERE a.state='ACCOUNTING_COMPLETE' AND a.binding->>'network'='eip155:5042' AND (
      a.purchase_id IS NULL OR a.settlement_identity IS NULL OR length(a.settlement_identity)=0 OR p.id IS NULL
      OR a.fingerprint IS NULL OR length(a.fingerprint)=0
      OR a.authorization_key IS NULL OR length(a.authorization_key)=0
      OR a.binding->>'pay_to' IS DISTINCT FROM '0x052650d1764406d702252b20b2294346a594a1ef'
      OR a.binding->>'asset' IS DISTINCT FROM '0x3600000000000000000000000000000000000000'
      OR p.settlement_attempt_id IS DISTINCT FROM a.id
      OR p.tx_hash IS DISTINCT FROM a.settlement_identity
      OR p.api_id IS DISTINCT FROM a.api_id
      OR a.binding->>'fingerprint' IS DISTINCT FROM a.fingerprint
      OR a.binding->>'authorization_key' IS DISTINCT FROM a.authorization_key
      OR a.binding->>'api_id' IS DISTINCT FROM a.api_id::text
      OR lower(p.buyer_wallet) IS DISTINCT FROM a.binding->>'payer'
      OR coalesce(a.binding->>'amount_atomic','') !~ '^(0|[1-9][0-9]*)$'
      OR coalesce(a.binding->>'seller_atomic','') !~ '^(0|[1-9][0-9]*)$'
      OR coalesce(a.binding->>'platform_atomic','') !~ '^(0|[1-9][0-9]*)$'
      OR CASE WHEN a.binding->>'seller_atomic' ~ '^(0|[1-9][0-9]*)$'
          THEN (a.binding->>'seller_atomic')::numeric <= 0 ELSE true END
      OR p.seller_share_usdc IS NULL
      OR p.amount_usdc * 1000000 IS DISTINCT FROM
        CASE WHEN a.binding->>'amount_atomic' ~ '^(0|[1-9][0-9]*)$'
          THEN (a.binding->>'amount_atomic')::numeric END
      OR p.seller_share_usdc * 1000000 IS DISTINCT FROM
        CASE WHEN a.binding->>'seller_atomic' ~ '^(0|[1-9][0-9]*)$'
          THEN (a.binding->>'seller_atomic')::numeric END
      OR CASE WHEN a.binding->>'amount_atomic' ~ '^(0|[1-9][0-9]*)$'
          THEN (a.binding->>'amount_atomic')::numeric END IS DISTINCT FROM
        CASE WHEN a.binding->>'seller_atomic' ~ '^(0|[1-9][0-9]*)$'
                  AND a.binding->>'platform_atomic' ~ '^(0|[1-9][0-9]*)$'
          THEN (a.binding->>'seller_atomic')::numeric + (a.binding->>'platform_atomic')::numeric END
    )
  ) THEN RAISE EXCEPTION 'commission settlement accounting conflict'; END IF;

  -- Confirmed payments awaiting accounting are debt; unknown attempts are preserved without counting as debt.
  IF EXISTS (SELECT 1 FROM public.x402_settlement_attempts a
    WHERE state = 'SETTLEMENT_CONFIRMED' AND (
      a.binding->>'network' IS DISTINCT FROM 'eip155:5042'
      OR a.binding->>'pay_to' IS DISTINCT FROM '0x052650d1764406d702252b20b2294346a594a1ef'
      OR a.binding->>'asset' IS DISTINCT FROM '0x3600000000000000000000000000000000000000'
      OR coalesce(a.binding->>'amount_atomic','') !~ '^(0|[1-9][0-9]*)$'
      OR coalesce(a.binding->>'seller_atomic','') !~ '^(0|[1-9][0-9]*)$'
      OR coalesce(a.binding->>'platform_atomic','') !~ '^(0|[1-9][0-9]*)$'
      OR CASE WHEN a.binding->>'seller_atomic' ~ '^(0|[1-9][0-9]*)$'
        THEN (a.binding->>'seller_atomic')::numeric <= 0 ELSE true END
      OR CASE WHEN a.binding->>'amount_atomic' ~ '^(0|[1-9][0-9]*)$'
        THEN (a.binding->>'amount_atomic')::numeric END IS DISTINCT FROM
      CASE WHEN a.binding->>'seller_atomic' ~ '^(0|[1-9][0-9]*)$'
        AND a.binding->>'platform_atomic' ~ '^(0|[1-9][0-9]*)$'
        THEN (a.binding->>'seller_atomic')::numeric + (a.binding->>'platform_atomic')::numeric END
      OR (SELECT count(*) FROM public.purchases p WHERE p.settlement_attempt_id=a.id OR p.id=a.purchase_id) > 1
      OR EXISTS (SELECT 1 FROM public.purchases p
        WHERE (p.settlement_attempt_id=a.id OR p.id=a.purchase_id) AND
          (p.seller_share_usdc IS NULL OR p.seller_share_usdc * 1000000 IS DISTINCT FROM
            CASE WHEN a.binding->>'seller_atomic' ~ '^(0|[1-9][0-9]*)$'
              THEN (a.binding->>'seller_atomic')::numeric END))
    )) THEN RAISE EXCEPTION 'invalid confirmed settlement liability'; END IF;

  SELECT coalesce(sum(seller_share_usdc),0) INTO shares FROM public.purchases
    WHERE seller_share_usdc IS NOT NULL;
  SELECT coalesce(sum(amount_usdc),0) INTO paid FROM public.seller_withdrawals WHERE status='minted';
  IF paid > shares THEN RAISE EXCEPTION 'seller ledger exceeds recorded shares'; END IF;
  IF EXISTS (SELECT 1 FROM public.seller_withdrawals WHERE status NOT IN ('minted','expired')) THEN
    RAISE EXCEPTION 'seller withdrawal needs reconciliation';
  END IF;
  SELECT coalesce(sum((binding->>'platform_atomic')::numeric),0)/1000000 INTO accrued_usdc
    FROM public.x402_settlement_attempts WHERE state='ACCOUNTING_COMPLETE' AND binding->>'network'='eip155:5042';
  SELECT coalesce(sum((a.binding->>'seller_atomic')::numeric),0)/1000000 INTO confirmed_seller_reserve_usdc
    FROM public.x402_settlement_attempts a WHERE state='SETTLEMENT_CONFIRMED'
    AND NOT EXISTS (SELECT 1 FROM public.purchases p WHERE p.settlement_attempt_id=a.id OR p.id=a.purchase_id);
  SELECT coalesce(sum(amount_usdc),0), coalesce(sum(amount_usdc) FILTER (WHERE status <> 'minted'),0)
    INTO consumed,reserved_usdc FROM public.admin_gateway_commission_withdrawals WHERE status <> 'expired';
  IF consumed > accrued_usdc THEN RAISE EXCEPTION 'platform withdrawals exceed recorded commission'; END IF;
  remaining_usdc := accrued_usdc - consumed;
  seller_liabilities_usdc := shares - paid;
  allowance_usdc := greatest(0, least(remaining_usdc,
    p_gateway_available_usdc - seller_liabilities_usdc - confirmed_seller_reserve_usdc - reserved_usdc));
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_admin_commission_limits(numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_commission_limits(numeric) TO service_role;

CREATE FUNCTION public.mahshar_reserve_admin_commission_withdrawal(
  p_idempotency_key uuid, p_amount_usdc numeric, p_mint_value_usdc numeric,
  p_source_fee_cap_usdc numeric, p_destination_gas_estimate_usdc numeric,
  p_gateway_available_usdc numeric
) RETURNS public.admin_gateway_commission_withdrawals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prior public.admin_gateway_commission_withdrawals;
  reserved public.admin_gateway_commission_withdrawals;
  capacity record;
BEGIN
  IF p_idempotency_key IS NULL OR p_amount_usdc IS NULL OR p_amount_usdc < 0.05 OR p_amount_usdc > 10000
    OR p_amount_usdc <> trunc(p_amount_usdc,6)
    OR p_mint_value_usdc IS NULL OR p_mint_value_usdc <= 0
    OR p_mint_value_usdc <> trunc(p_mint_value_usdc,6)
    OR p_source_fee_cap_usdc IS NULL OR p_source_fee_cap_usdc <= 0
    OR p_source_fee_cap_usdc <> trunc(p_source_fee_cap_usdc,6)
    OR p_amount_usdc <> p_mint_value_usdc + p_source_fee_cap_usdc
    OR p_destination_gas_estimate_usdc IS NULL OR p_destination_gas_estimate_usdc < 0
    OR p_destination_gas_estimate_usdc > 10000
    OR p_destination_gas_estimate_usdc <> trunc(p_destination_gas_estimate_usdc,6)
  THEN RAISE EXCEPTION 'invalid commission withdrawal reservation'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('mahshar-admin-commission-withdrawal',0));
  SELECT * INTO prior FROM public.admin_gateway_commission_withdrawals WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF prior.amount_usdc <> p_amount_usdc OR prior.mint_value_usdc <> p_mint_value_usdc
      OR prior.source_fee_cap_usdc <> p_source_fee_cap_usdc THEN
      RAISE EXCEPTION 'idempotency key amount mismatch';
    END IF;
    RETURN prior;
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_gateway_commission_withdrawals
    WHERE status NOT IN ('minted','expired')) THEN RAISE EXCEPTION 'platform withdrawal needs reconciliation'; END IF;
  SELECT * INTO STRICT capacity FROM public.mahshar_admin_commission_limits(p_gateway_available_usdc);
  IF p_amount_usdc > capacity.allowance_usdc THEN RAISE EXCEPTION 'insufficient protected commission'; END IF;
  INSERT INTO public.admin_gateway_commission_withdrawals
    (idempotency_key,amount_usdc,mint_value_usdc,source_fee_cap_usdc,destination_gas_estimate_usdc)
  VALUES (p_idempotency_key,p_amount_usdc,p_mint_value_usdc,p_source_fee_cap_usdc,p_destination_gas_estimate_usdc)
  RETURNING * INTO reserved;
  RETURN reserved;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_reserve_admin_commission_withdrawal(
  uuid,numeric,numeric,numeric,numeric,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_reserve_admin_commission_withdrawal(
  uuid,numeric,numeric,numeric,numeric,numeric) TO service_role;

-- Re-read the protected ledger immediately before signing. Own reservation is
-- already counted in reserved_usdc; a new seller claim cannot use that allowance.
CREATE FUNCTION public.mahshar_validate_admin_commission_withdrawal(
  p_withdrawal_id uuid, p_gateway_available_usdc numeric
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  capacity record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mahshar-admin-commission-withdrawal',0));
  IF NOT EXISTS (SELECT 1 FROM public.admin_gateway_commission_withdrawals
      WHERE id=p_withdrawal_id AND status='preparing') THEN
    RAISE EXCEPTION 'commission withdrawal is not preparing';
  END IF;
  SELECT * INTO STRICT capacity FROM public.mahshar_admin_commission_limits(p_gateway_available_usdc);
  IF p_gateway_available_usdc < capacity.seller_liabilities_usdc +
    capacity.confirmed_seller_reserve_usdc + capacity.reserved_usdc THEN
    RAISE EXCEPTION 'protected commission allowance changed';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_validate_admin_commission_withdrawal(uuid,numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_validate_admin_commission_withdrawal(uuid,numeric) TO service_role;

-- Serialize only competing outgoing reservations. Seller amounts, nonces,
-- entitlement RPCs and payment settlement are unchanged. Once Circle has accepted
-- the commission burn, pending destination minting does not block new sellers.
CREATE FUNCTION public.mahshar_guard_seller_during_commission_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mahshar-admin-commission-withdrawal',0));
  IF EXISTS (SELECT 1 FROM public.admin_gateway_commission_withdrawals
      WHERE status IN ('reserved','preparing','submission_unknown')) THEN
    RAISE EXCEPTION 'platform commission submission in progress' USING ERRCODE='55P03';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_guard_seller_during_commission_submission() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER seller_withdrawal_commission_submission_guard BEFORE INSERT ON public.seller_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.mahshar_guard_seller_during_commission_submission();
