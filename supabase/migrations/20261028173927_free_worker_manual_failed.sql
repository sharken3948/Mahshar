-- Manual Admin classification only. No existing records are moved or published.
ALTER TABLE public.free_worker_apis
  ADD COLUMN manual_failed_at timestamptz,
  ADD COLUMN manual_failed_by text,
  ADD COLUMN failure_reason text,
  ADD COLUMN failure_history jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN recheck_result jsonb,
  ADD COLUMN recheck_token uuid,
  ADD COLUMN recheck_until timestamptz;

CREATE FUNCTION public.free_worker_failed_move(p_ids text[],p_owner text,p_confirmed boolean) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE candidate free_worker_apis; reason text; moved integer=0;
BEGIN
  IF p_owner IS DISTINCT FROM '0x540a0027509b1c9aa0a2c5c65491cc97083e16de' OR p_confirmed IS DISTINCT FROM true THEN RAISE EXCEPTION 'explicit_owner_confirmation_required'; END IF;
  IF coalesce(cardinality(p_ids),0) NOT BETWEEN 1 AND 25 OR cardinality(p_ids)<>(SELECT count(DISTINCT v) FROM unnest(p_ids) v) THEN RAISE EXCEPTION 'invalid_selection'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  PERFORM 1 FROM free_worker_apis WHERE id=ANY(p_ids) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM free_worker_apis WHERE id=ANY(p_ids) AND removed_at IS NULL AND published_at IS NULL)<>cardinality(p_ids)
    OR EXISTS(SELECT 1 FROM api_listings WHERE free_worker_candidate_id=ANY(p_ids) AND is_active) THEN RAISE EXCEPTION 'candidate_not_available'; END IF;
  IF EXISTS(SELECT 1 FROM free_worker_apis WHERE id=ANY(p_ids) AND (lease_until>clock_timestamp() OR recheck_until>clock_timestamp()))
    OR EXISTS(SELECT 1 FROM free_worker_bulk_items WHERE candidate_id=ANY(p_ids) AND status='processing' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'work_in_flight'; END IF;
  FOR candidate IN SELECT * FROM free_worker_apis WHERE id=ANY(p_ids) AND manual_failed_at IS NULL ORDER BY id LOOP
    SELECT last_error INTO reason FROM free_worker_bulk_items WHERE candidate_id=candidate.id AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1;
    reason=coalesce(reason,nullif(candidate.result->>'reason','validated'),'Manually moved to Failed APIs by Admin.');
    UPDATE free_worker_apis SET manual_failed_at=clock_timestamp(),manual_failed_by=p_owner,failure_reason=left(reason,1200),
      token=NULL,lease_until=NULL,recheck_token=NULL,recheck_until=NULL,
      failure_history=failure_history||jsonb_build_array(jsonb_build_object('event','manual_move','at',clock_timestamp(),'by',p_owner,
        'reason',left(reason,1200),'lead',candidate.lead,'result',candidate.result,'listingId',candidate.listing_id))
      WHERE id=candidate.id;
    moved=moved+1;
  END LOOP;
  RETURN moved;
END $$;

CREATE FUNCTION public.free_worker_failed_begin(p_id text,p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE candidate free_worker_apis;
BEGIN
  IF p_owner IS DISTINCT FROM '0x540a0027509b1c9aa0a2c5c65491cc97083e16de' THEN RAISE EXCEPTION 'owner_wallet_required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  SELECT * INTO candidate FROM free_worker_apis WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR candidate.manual_failed_at IS NULL OR candidate.removed_at IS NOT NULL OR candidate.published_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM api_listings WHERE free_worker_candidate_id=p_id AND is_active) THEN RAISE EXCEPTION 'candidate_not_failed'; END IF;
  IF candidate.recheck_until>clock_timestamp() OR candidate.lease_until>clock_timestamp()
    OR EXISTS(SELECT 1 FROM free_worker_bulk_items WHERE candidate_id=p_id AND status='processing' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'work_in_flight'; END IF;
  UPDATE free_worker_apis SET recheck_token=gen_random_uuid(),recheck_until=clock_timestamp()+interval '10 minutes',
    failure_history=failure_history||jsonb_build_array(jsonb_build_object('event','recheck_requested','at',clock_timestamp(),'by',p_owner,'reason',failure_reason))
    WHERE id=p_id RETURNING * INTO candidate;
  RETURN to_jsonb(candidate);
END $$;

CREATE FUNCTION public.free_worker_failed_finish(p_id text,p_owner text,p_token uuid,p_result jsonb,p_recovered boolean,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE candidate free_worker_apis; recovered boolean=p_recovered; reason text=p_reason;
BEGIN
  IF p_owner IS DISTINCT FROM '0x540a0027509b1c9aa0a2c5c65491cc97083e16de' THEN RAISE EXCEPTION 'owner_wallet_required'; END IF;
  SELECT * INTO candidate FROM free_worker_apis WHERE id=p_id AND manual_failed_at IS NOT NULL AND removed_at IS NULL
    AND published_at IS NULL AND recheck_token=p_token AND recheck_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF recovered AND (p_result->'validation'->>'technical' IS DISTINCT FROM 'PASSED'
    OR p_result->'validation'->>'freeAccess' IS DISTINCT FROM 'VERIFIED'
    OR p_result->'validation'->>'termsChecked' IS DISTINCT FROM 'true'
    OR coalesce(p_result->'validation'->>'permission','') NOT IN ('ALLOWED','UNKNOWN','REVIEW_REQUIRED')
    OR nullif(p_result->'validation'->>'endpoint','') IS NULL OR nullif(p_result->'validation'->>'lastSuccess','') IS NULL
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'validation'->'tests') t WHERE t->>'status'='200' AND nullif(t->>'sha256','') IS NOT NULL)) THEN RAISE EXCEPTION 'invalid_recovery'; END IF;
  IF recovered THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('free_worker_resource_identity',0));
    IF candidate.lead->>'duplicateOf' IS NOT NULL OR EXISTS(SELECT 1 FROM free_worker_apis a WHERE a.id<>p_id AND a.lead->>'duplicateOf' IS NULL
      AND a.identity_keys && free_worker_keys('{}',p_result->'validation')
      AND (coalesce(a.lead->>'serviceIdentity','')='' OR coalesce(candidate.lead->>'serviceIdentity','')='' OR a.lead->>'serviceIdentity'=candidate.lead->>'serviceIdentity'))
      OR EXISTS(SELECT 1 FROM api_listings WHERE endpoint_url=p_result->'validation'->>'endpoint' AND free_worker_candidate_id IS DISTINCT FROM p_id) THEN
      recovered=false; reason='Working endpoint belongs to an existing candidate or Marketplace listing; review the duplicate.';
    ELSIF EXISTS(SELECT 1 FROM api_listings WHERE free_worker_candidate_id=p_id AND (is_active OR seller_wallet IS DISTINCT FROM p_owner)) THEN
      recovered=false; reason='The listing changed during recheck; recovery was not applied.';
    ELSIF EXISTS(SELECT 1 FROM api_listings WHERE free_worker_candidate_id=p_id AND endpoint_url IS DISTINCT FROM p_result->'validation'->>'endpoint') THEN
      reason='Validation recovered. The saved draft is unchanged; review its new endpoint in Seller before Bulk List.';
    END IF;
  END IF;
  UPDATE free_worker_apis SET
    result=CASE WHEN recovered THEN p_result->'validation' ELSE result END,
    completed_at=CASE WHEN recovered THEN clock_timestamp() ELSE completed_at END,
    retry_at=CASE WHEN recovered THEN NULL ELSE retry_at END,
    manual_failed_at=CASE WHEN recovered THEN NULL ELSE manual_failed_at END,
    manual_failed_by=CASE WHEN recovered THEN NULL ELSE manual_failed_by END,
    failure_reason=left(reason,1200),recheck_result=p_result||jsonb_build_object('recovered',recovered,'reason',left(reason,1200)),
    recheck_token=NULL,recheck_until=NULL,
    failure_history=failure_history||jsonb_build_array(jsonb_build_object('event',CASE WHEN recovered THEN 'recovered' ELSE 'unresolved' END,
      'at',clock_timestamp(),'by',p_owner,'reason',left(reason,1200),'evidence',p_result))
    WHERE id=p_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.free_worker_failed_move(text[],text,boolean),public.free_worker_failed_begin(text,text),public.free_worker_failed_finish(text,text,uuid,jsonb,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_failed_move(text[],text,boolean),public.free_worker_failed_begin(text,text),public.free_worker_failed_finish(text,text,uuid,jsonb,boolean,text) TO service_role;


-- Preserve normal processing; manually separated candidates are never auto-claimed.
CREATE OR REPLACE FUNCTION public.free_worker_claim(p_generation uuid, p_limit integer DEFAULT 3) RETURNS SETOF public.free_worker_apis
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  -- Lock the control row so a concurrent Stop fences subsequent claims.
  PERFORM 1 FROM public.free_worker_state WHERE id=1 AND status='running' AND generation=p_generation FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY WITH chosen AS (
    SELECT id FROM public.free_worker_apis
    WHERE manual_failed_at IS NULL AND removed_at IS NULL AND completed_at IS NULL AND (result IS NULL OR retry_at IS NULL OR retry_at<=clock_timestamp())
      AND last_generation IS DISTINCT FROM p_generation
      AND (token IS NULL OR lease_until<clock_timestamp())
    ORDER BY id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,3))
  ) UPDATE public.free_worker_apis a SET token=gen_random_uuid(),lease_until=clock_timestamp()+interval '15 minutes',
    claim_generation=p_generation,attempts=attempts+1,updated_at=clock_timestamp()
    FROM chosen c WHERE a.id=c.id RETURNING a.*;
END $$;


-- Preserve normal processing; manually separated candidates are never auto-claimed.
CREATE OR REPLACE FUNCTION public.free_worker_finish(p_generation uuid,p_cooldowns jsonb,p_error text DEFAULT NULL)
RETURNS public.free_worker_state LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.free_worker_state; remains boolean; retryable boolean; pauses jsonb;
BEGIN
  SELECT * INTO s FROM public.free_worker_state WHERE id=1 FOR UPDATE;
  -- A late in-flight result may extend an external pause, never shorten it.
  SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO pauses FROM (
    SELECT key,max(value) AS value FROM (
      SELECT key,value FROM jsonb_each_text(s.cooldowns)
      UNION ALL SELECT key,value FROM jsonb_each_text(p_cooldowns)
    ) all_pauses GROUP BY key
  ) merged WHERE value::timestamptz>clock_timestamp();
  SELECT EXISTS(SELECT 1 FROM public.free_worker_apis
    WHERE manual_failed_at IS NULL AND removed_at IS NULL AND completed_at IS NULL AND (result IS NULL OR retry_at IS NULL OR retry_at<=clock_timestamp()) AND last_generation IS DISTINCT FROM p_generation
      AND (token IS NULL OR lease_until<clock_timestamp())) INTO remains;
  SELECT EXISTS(SELECT 1 FROM public.free_worker_apis WHERE manual_failed_at IS NULL AND removed_at IS NULL AND completed_at IS NULL AND (retry_at IS NOT NULL OR token IS NOT NULL)) INTO retryable;
  UPDATE public.free_worker_state SET cooldowns=pauses,
    status=CASE WHEN generation<>p_generation OR status<>'running' THEN status
      WHEN p_error IS NOT NULL THEN 'stopped' WHEN remains OR NOT discovery_done OR discovery IS NOT NULL THEN 'running'
      WHEN retryable OR NOT discovery_done THEN 'stopped' ELSE 'completed' END,
    error=CASE WHEN generation=p_generation THEN coalesce(p_error,error) ELSE error END,
    updated_at=clock_timestamp() WHERE id=1 RETURNING * INTO s;
  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public.free_worker_listing_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE candidate public.free_worker_apis;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.free_worker_candidate_id IS DISTINCT FROM NEW.free_worker_candidate_id THEN
    RAISE EXCEPTION 'Worker listing association is immutable';
  END IF;
  IF NEW.free_worker_candidate_id IS NULL THEN RETURN NEW; END IF;
  -- Disabling a product must remain possible even if saved rights later change.
  IF TG_OP = 'UPDATE' AND NOT NEW.is_active
    AND (to_jsonb(NEW) - 'is_active') = (to_jsonb(OLD) - 'is_active') THEN RETURN NEW; END IF;
  SELECT * INTO candidate FROM public.free_worker_apis WHERE id = NEW.free_worker_candidate_id FOR UPDATE;
  IF candidate.manual_failed_at IS NOT NULL AND (TG_OP='INSERT' OR NEW.is_active) THEN
    RAISE EXCEPTION 'Candidate is manually held in Failed APIs'; END IF;
  IF candidate.id IS NULL OR candidate.removed_at IS NOT NULL
    OR candidate.lead->>'duplicateOf' IS NOT NULL
    OR candidate.result->>'technical' IS DISTINCT FROM 'PASSED'
    OR candidate.result->>'freeAccess' IS DISTINCT FROM 'VERIFIED'
    OR candidate.result->>'termsChecked' IS DISTINCT FROM 'true'
    OR coalesce(candidate.result->>'permission','') NOT IN ('ALLOWED','UNKNOWN','REVIEW_REQUIRED')
    OR NEW.seller_wallet IS DISTINCT FROM '0x540a0027509b1c9aa0a2c5c65491cc97083e16de'
    OR NEW.endpoint_url IS DISTINCT FROM candidate.result->>'endpoint'
    OR NEW.method IS DISTINCT FROM 'GET' OR NEW.auth_type IS DISTINCT FROM 'public'
    OR NEW.encrypted_key IS NOT NULL OR NEW.body_required IS TRUE OR NEW.dynamic_path_supported IS TRUE
    OR coalesce(NEW.path_parameters,'[]'::jsonb) <> '[]'::jsonb
    OR coalesce(NEW.query_parameters,'[]'::jsonb) <> '[]'::jsonb
    OR NEW.request_schema IS NOT NULL
    OR NEW.payment_model IS DISTINCT FROM 'pay-per-call' OR NEW.price_per_call < 0 THEN
    RAISE EXCEPTION 'Worker listing contract does not match saved candidate';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.seller_wallet || ':' || NEW.endpoint_url, 0));
  IF EXISTS (SELECT 1 FROM public.api_listings WHERE seller_wallet = NEW.seller_wallet AND endpoint_url = NEW.endpoint_url AND id <> NEW.id) THEN
    RAISE EXCEPTION 'Endpoint already has a Seller listing';
  END IF;
  IF candidate.listing_id IS NOT NULL AND candidate.listing_id <> NEW.id THEN
    RAISE EXCEPTION 'Candidate already has a listing reference';
  END IF;
  -- Owner declaration is separate from the unchanged provider permission findings.
  IF NEW.price_per_call > 0 AND (
    NEW.owner_rights_confirmation IS NULL
    OR jsonb_typeof(NEW.owner_rights_confirmation) IS DISTINCT FROM 'object'
    OR NEW.owner_rights_confirmation->'confirmed' IS DISTINCT FROM 'true'::jsonb
    OR NEW.owner_rights_confirmation->>'version' IS DISTINCT FROM 'paid-api-access-v1'
    OR NEW.owner_rights_confirmation->>'owner' IS DISTINCT FROM NEW.seller_wallet
    OR NEW.owner_rights_confirmation->>'candidateId' IS DISTINCT FROM NEW.free_worker_candidate_id
    OR NEW.owner_rights_confirmation->>'endpoint' IS DISTINCT FROM NEW.endpoint_url
    OR nullif(NEW.owner_rights_confirmation->>'confirmedAt','') IS NULL) THEN
    RAISE EXCEPTION 'Explicit owner confirmation of established paid proxy/resale rights is required';
  END IF;
  IF NEW.is_active AND NEW.verified_at IS NULL THEN RAISE EXCEPTION 'Verify the endpoint before activation'; END IF;
  UPDATE public.free_worker_apis SET listing_id = NEW.id,
    published_at = CASE WHEN NEW.is_active THEN coalesce(published_at, now()) ELSE published_at END
    WHERE id = candidate.id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.free_worker_remove(p_ids text[],p_owner text) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE count_removed integer;
BEGIN
  IF p_owner<>'0x540a0027509b1c9aa0a2c5c65491cc97083e16de' THEN RAISE EXCEPTION 'owner_wallet_required'; END IF;
  -- Retain rows and evidence. Suppress endpoint aliases as well as the selected identity.
  WITH selected AS (SELECT id,result->>'endpoint' endpoint FROM public.free_worker_apis
    WHERE id=ANY(p_ids) AND removed_at IS NULL AND published_at IS NULL AND (manual_failed_at IS NOT NULL OR (result->>'technical'='PASSED'
      AND result->>'freeAccess'='VERIFIED' AND (result->>'termsChecked')::boolean
      AND result->>'permission' IN ('ALLOWED','UNKNOWN','REVIEW_REQUIRED')))), changed AS (
  UPDATE public.free_worker_apis a SET removed_at=clock_timestamp(),removed_by=p_owner
    WHERE a.removed_at IS NULL AND a.published_at IS NULL AND NOT EXISTS(SELECT 1 FROM api_listings l WHERE l.free_worker_candidate_id=a.id AND l.is_active) AND EXISTS(SELECT 1 FROM selected s WHERE a.id=s.id OR a.result->>'endpoint'=s.endpoint) RETURNING a.id)
  SELECT count(*) INTO count_removed FROM changed WHERE id=ANY(p_ids);
  RETURN count_removed;
END $$;

-- Retain the existing append-only identity registry and include published endpoints.
CREATE OR REPLACE FUNCTION public.free_worker_set_keys() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE representative text;
BEGIN
  SELECT array_agg(DISTINCT key) INTO NEW.identity_keys FROM (
    SELECT unnest(coalesce(NEW.identity_keys,'{}')||public.free_worker_keys(NEW.lead,NEW.result)) key
    UNION ALL SELECT unnest(public.free_worker_keys(v->'lead',v->'result'))
      FROM jsonb_array_elements(coalesce(NEW.saved_inventory->'aliases','[]')) v
    UNION ALL SELECT unnest(public.free_worker_keys(NEW.saved_inventory->'original'->'lead',NEW.saved_inventory->'original'->'result'))
  ) keys WHERE key IS NOT NULL;
  -- Some catalogues document different resources of the same API. Once the
  -- documented working resource resolves to an existing identity, retain the
  -- evidence as an alias instead of creating a second Ready entry.
  IF NEW.saved_inventory IS NULL AND NEW.result->>'endpoint' IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('free_worker_resource_identity',0));
    SELECT id INTO representative FROM public.free_worker_apis a WHERE a.id<>NEW.id
      AND a.identity_keys && public.free_worker_keys('{}',NEW.result)
      AND a.lead->>'duplicateOf' IS NULL
      AND (coalesce(a.lead->>'serviceIdentity','')='' OR coalesce(NEW.lead->>'serviceIdentity','')=''
        OR a.lead->>'serviceIdentity'=NEW.lead->>'serviceIdentity')
      ORDER BY (a.saved_inventory IS NOT NULL) DESC,a.id LIMIT 1;
    IF representative IS NOT NULL THEN NEW.lead=jsonb_set(NEW.lead,'{duplicateOf}',to_jsonb(representative)); END IF;
  END IF;
  -- Existing Marketplace products also suppress newly encountered endpoint aliases.
  IF NEW.lead->>'duplicateOf' IS NULL AND NEW.result->>'endpoint' IS NOT NULL THEN
    SELECT 'marketplace:'||id::text INTO representative FROM public.api_listings
      WHERE is_active AND free_worker_candidate_id IS DISTINCT FROM NEW.id
        AND free_worker_keys('{}',jsonb_build_object('endpoint',endpoint_url)) && free_worker_keys('{}',NEW.result)
      ORDER BY id LIMIT 1;
    IF representative IS NOT NULL THEN NEW.lead=jsonb_set(NEW.lead,'{duplicateOf}',to_jsonb(representative)); END IF;
  END IF;
  RETURN NEW;
END $$;
