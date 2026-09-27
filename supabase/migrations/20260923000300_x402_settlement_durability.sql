-- Additive. No historical purchase identities are guessed or rewritten.
CREATE TABLE public.x402_settlement_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  authorization_key text NOT NULL UNIQUE CHECK (authorization_key ~ '^[a-f0-9]{64}$'),
  api_id uuid NOT NULL REFERENCES public.api_listings(id),
  binding jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED','SETTLEMENT_SUBMITTED','SETTLEMENT_CONFIRMED','ACCOUNTING_COMPLETE','SETTLEMENT_UNKNOWN','MANUAL_REVIEW')),
  submission_token uuid,
  submitted_at timestamptz,
  transaction_id text,
  settlement_identity text UNIQUE,
  purchase_id uuid REFERENCES public.purchases(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state NOT IN ('SETTLEMENT_CONFIRMED','ACCOUNTING_COMPLETE') OR settlement_identity IS NOT NULL),
  CHECK (state <> 'ACCOUNTING_COMPLETE' OR purchase_id IS NOT NULL)
);
ALTER TABLE public.x402_settlement_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.x402_settlement_attempts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.x402_settlement_attempts TO service_role;
CREATE INDEX x402_attempts_incomplete ON public.x402_settlement_attempts(updated_at) WHERE state <> 'ACCOUNTING_COMPLETE';
ALTER TABLE public.purchases ADD COLUMN settlement_attempt_id uuid UNIQUE REFERENCES public.x402_settlement_attempts(id);

CREATE FUNCTION public.x402_prepare(p_binding jsonb) RETURNS public.x402_settlement_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.x402_settlement_attempts;
BEGIN
  IF p_binding IS NULL OR jsonb_typeof(p_binding) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_each(p_binding) WHERE value='null'::jsonb)
    OR NOT (p_binding ?& ARRAY['fingerprint','authorization_key','proof_hash','api_id','payer','seller','network','asset','pay_to','nonce','amount_atomic','seller_atomic','platform_atomic','authorization','requirements'])
    OR p_binding->>'proof_hash' !~ '^[a-f0-9]{64}$'
    OR p_binding->>'payer' !~ '^0x[a-f0-9]{40}$'
    OR p_binding->>'seller' !~ '^0x[a-f0-9]{40}$'
    OR p_binding->>'asset' !~ '^0x[a-f0-9]{40}$'
    OR p_binding->>'pay_to' !~ '^0x[a-f0-9]{40}$'
    OR p_binding->>'nonce' !~ '^0x[a-f0-9]{64}$'
    OR p_binding->>'network' NOT IN ('eip155:5042')
    OR p_binding->>'amount_atomic' !~ '^[0-9]+$' OR p_binding->>'seller_atomic' !~ '^[0-9]+$' OR p_binding->>'platform_atomic' !~ '^[0-9]+$'
    OR (p_binding->>'seller_atomic')::numeric <= 0
    OR (p_binding->>'platform_atomic')::numeric < 0
    OR (p_binding->>'amount_atomic')::numeric <> (p_binding->>'seller_atomic')::numeric + (p_binding->>'platform_atomic')::numeric
    OR p_binding->'authorization'->>'from' IS DISTINCT FROM p_binding->>'payer'
    OR p_binding->'authorization'->>'nonce' IS DISTINCT FROM p_binding->>'nonce'
    OR p_binding->'authorization'->>'value' IS DISTINCT FROM p_binding->>'amount_atomic'
    OR p_binding->'authorization'->>'to' IS DISTINCT FROM p_binding->>'pay_to'
    OR lower(p_binding->'requirements'->>'asset') IS DISTINCT FROM p_binding->>'asset'
    OR lower(p_binding->'requirements'->>'payTo') IS DISTINCT FROM p_binding->>'pay_to'
    OR p_binding->'requirements'->>'network' IS DISTINCT FROM p_binding->>'network'
    OR p_binding->'requirements'->>'amount' IS DISTINCT FROM p_binding->>'amount_atomic'
  THEN RAISE EXCEPTION 'invalid settlement binding'; END IF;
  -- Prevent deletion/reassignment of the listing from redirecting recovery credit.
  PERFORM 1 FROM public.api_listings WHERE id=(p_binding->>'api_id')::uuid AND lower(seller_wallet)=p_binding->>'seller' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing owner conflict'; END IF;
  INSERT INTO public.x402_settlement_attempts(fingerprint,authorization_key,api_id,binding)
    VALUES (p_binding->>'fingerprint',p_binding->>'authorization_key',(p_binding->>'api_id')::uuid,p_binding)
    ON CONFLICT (authorization_key) DO NOTHING;
  SELECT * INTO STRICT a FROM public.x402_settlement_attempts WHERE authorization_key=p_binding->>'authorization_key' FOR UPDATE;
  IF a.binding IS DISTINCT FROM p_binding THEN RAISE EXCEPTION 'payment binding conflict'; END IF;
  RETURN a;
END $$;

CREATE FUNCTION public.x402_claim(p_id uuid, p_token uuid) RETURNS public.x402_settlement_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.x402_settlement_attempts;
BEGIN
  IF p_token IS NULL THEN RAISE EXCEPTION 'submission token required'; END IF;
  UPDATE public.x402_settlement_attempts SET state='SETTLEMENT_SUBMITTED', submission_token=p_token, submitted_at=now(), updated_at=now()
    WHERE id=p_id AND state='PREPARED' RETURNING * INTO a;
  RETURN a;
END $$;

CREATE FUNCTION public.x402_confirm(p_id uuid, p_token uuid, p_transaction text) RETURNS public.x402_settlement_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.x402_settlement_attempts; identity text; tx text := nullif(btrim(p_transaction),'');
BEGIN
  SELECT * INTO STRICT a FROM public.x402_settlement_attempts WHERE id=p_id FOR UPDATE;
  IF p_token IS NULL OR a.submission_token IS DISTINCT FROM p_token OR length(tx)>512 THEN RAISE EXCEPTION 'confirmation conflict'; END IF;
  IF a.state IN ('SETTLEMENT_CONFIRMED','ACCOUNTING_COMPLETE') THEN
    IF a.transaction_id IS DISTINCT FROM tx THEN RAISE EXCEPTION 'confirmation identity conflict'; END IF;
    RETURN a;
  END IF;
  IF a.state NOT IN ('SETTLEMENT_SUBMITTED','SETTLEMENT_UNKNOWN','MANUAL_REVIEW') THEN RAISE EXCEPTION 'invalid confirmation state'; END IF;
  -- A batch transaction may cover several authorizations: retain both identities.
  identity := CASE WHEN tx IS NULL THEN 'x402:'||a.fingerprint ELSE 'circle:'||(a.binding->>'network')||':'||tx||':'||a.fingerprint END;
  UPDATE public.x402_settlement_attempts SET state='SETTLEMENT_CONFIRMED', transaction_id=tx,
    settlement_identity=identity, reason=NULL, updated_at=now() WHERE id=p_id RETURNING * INTO a;
  RETURN a;
END $$;

CREATE FUNCTION public.x402_unknown(p_id uuid, p_token uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_reason NOT IN ('settlement_transport_uncertain','facilitator_rejected_or_authorization_used','settlement_result_conflict') THEN RAISE EXCEPTION 'invalid uncertainty reason'; END IF;
  UPDATE public.x402_settlement_attempts SET state='SETTLEMENT_UNKNOWN',reason=p_reason,updated_at=now()
    WHERE id=p_id AND submission_token=p_token AND state='SETTLEMENT_SUBMITTED';
END $$;

CREATE FUNCTION public.x402_recover(p_id uuid) RETURNS public.x402_settlement_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.x402_settlement_attempts; purchase public.purchases;
BEGIN
  SELECT * INTO STRICT a FROM public.x402_settlement_attempts WHERE id=p_id FOR UPDATE;
  IF a.state='SETTLEMENT_UNKNOWN' OR (a.state='SETTLEMENT_SUBMITTED' AND a.submitted_at < now()-interval '2 minutes') THEN
    UPDATE public.x402_settlement_attempts SET state='MANUAL_REVIEW',reason=coalesce(reason,'settlement_acknowledgement_missing'),updated_at=now() WHERE id=p_id RETURNING * INTO a;
  END IF;
  IF a.state='ACCOUNTING_COMPLETE' THEN
    SELECT * INTO STRICT purchase FROM public.purchases WHERE settlement_attempt_id=a.id;
    IF purchase.id IS DISTINCT FROM a.purchase_id OR purchase.buyer_wallet IS DISTINCT FROM a.binding->>'payer'
      OR purchase.api_id IS DISTINCT FROM a.api_id OR purchase.tx_hash IS DISTINCT FROM a.settlement_identity
      OR purchase.amount_usdc IS DISTINCT FROM (a.binding->>'amount_atomic')::numeric/1000000
      OR purchase.seller_share_usdc IS DISTINCT FROM (a.binding->>'seller_atomic')::numeric/1000000
      THEN RAISE EXCEPTION 'accounting identity conflict'; END IF;
    RETURN a;
  END IF;
  IF a.state <> 'SETTLEMENT_CONFIRMED' THEN RETURN a; END IF;
  IF a.transaction_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.purchases WHERE tx_hash=a.transaction_id AND settlement_attempt_id IS NULL) THEN
    UPDATE public.x402_settlement_attempts SET state='MANUAL_REVIEW',reason='historical_transaction_identity_conflict',updated_at=now() WHERE id=p_id RETURNING * INTO a;
    RETURN a;
  END IF;
  PERFORM 1 FROM public.api_listings WHERE id=a.api_id AND lower(seller_wallet)=a.binding->>'seller' FOR SHARE;
  IF NOT FOUND THEN
    UPDATE public.x402_settlement_attempts SET state='MANUAL_REVIEW',reason='listing_owner_conflict',updated_at=now() WHERE id=p_id RETURNING * INTO a;
    RETURN a;
  END IF;
  INSERT INTO public.purchases(buyer_wallet,api_id,amount_usdc,seller_share_usdc,tx_hash,settlement_attempt_id)
    VALUES(a.binding->>'payer',a.api_id,(a.binding->>'amount_atomic')::numeric/1000000,
      (a.binding->>'seller_atomic')::numeric/1000000,a.settlement_identity,a.id)
    ON CONFLICT (settlement_attempt_id) DO NOTHING;
  SELECT * INTO STRICT purchase FROM public.purchases WHERE settlement_attempt_id=a.id;
  IF purchase.buyer_wallet IS DISTINCT FROM a.binding->>'payer' OR purchase.api_id IS DISTINCT FROM a.api_id
    OR purchase.amount_usdc IS DISTINCT FROM (a.binding->>'amount_atomic')::numeric/1000000
    OR purchase.seller_share_usdc IS DISTINCT FROM (a.binding->>'seller_atomic')::numeric/1000000
    OR purchase.tx_hash IS DISTINCT FROM a.settlement_identity THEN RAISE EXCEPTION 'accounting binding conflict'; END IF;
  UPDATE public.x402_settlement_attempts SET state='ACCOUNTING_COMPLETE',purchase_id=purchase.id,updated_at=now() WHERE id=p_id RETURNING * INTO a;
  RETURN a;
END $$;

REVOKE ALL ON FUNCTION public.x402_prepare(jsonb),public.x402_claim(uuid,uuid),public.x402_confirm(uuid,uuid,text),public.x402_unknown(uuid,uuid,text),public.x402_recover(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.x402_prepare(jsonb),public.x402_claim(uuid,uuid),public.x402_confirm(uuid,uuid,text),public.x402_unknown(uuid,uuid,text),public.x402_recover(uuid) TO service_role;
