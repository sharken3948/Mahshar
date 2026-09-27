-- Never discard financial recovery evidence. Export/reconcile before a later
-- separately reviewed rollback when attempts exist; this rollback is pre-use only.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.x402_settlement_attempts) THEN RAISE EXCEPTION 'Cannot rollback durable payment evidence'; END IF;
END $$;
DROP FUNCTION public.x402_prepare(jsonb), public.x402_claim(uuid,uuid), public.x402_confirm(uuid,uuid,text), public.x402_unknown(uuid,uuid,text), public.x402_recover(uuid);
ALTER TABLE public.purchases DROP COLUMN settlement_attempt_id;
DROP TABLE public.x402_settlement_attempts;
