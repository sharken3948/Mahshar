-- Source metadata is isolated from lifecycle locks. No provider, invitation or control rows are changed.
CREATE TABLE public.worker_discovery_sources (
  source_id text PRIMARY KEY CHECK (source_id IN ('apis_guru','public_api_lists')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  snapshot jsonb NOT NULL DEFAULT '{"entries":[],"cursor":0,"revision":null,"fetchedAt":null,"refreshAfter":null,"retryAfter":null,"failures":0}'::jsonb,
  CONSTRAINT worker_discovery_snapshot_check CHECK (
    jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=524288
    AND snapshot ?& ARRAY['entries','cursor','revision','fetchedAt','refreshAfter','retryAfter','failures']
    AND jsonb_typeof(snapshot->'entries')='array' AND jsonb_array_length(snapshot->'entries')<=2000
    AND jsonb_typeof(snapshot->'cursor')='number' AND (snapshot->>'cursor')::integer BETWEEN 0 AND jsonb_array_length(snapshot->'entries')
    AND jsonb_typeof(snapshot->'failures')='number' AND (snapshot->>'failures')::integer BETWEEN 0 AND 16
    AND ((snapshot->>'revision') IS NULL OR (snapshot->>'revision') ~ '^[a-f0-9]{64}$')
  )
);
INSERT INTO public.worker_discovery_sources(source_id) VALUES ('apis_guru'),('public_api_lists');
ALTER TABLE public.worker_discovery_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_discovery_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.worker_discovery_sources TO service_role;

ALTER TABLE public.worker_candidates
  ADD COLUMN source_id text CHECK (source_id IS NULL OR source_id IN ('apis_guru','public_api_lists')),
  ADD COLUMN source_record_id text CHECK (source_record_id IS NULL OR length(source_record_id) BETWEEN 1 AND 253),
  ADD COLUMN source_revision text CHECK (source_revision IS NULL OR source_revision ~ '^[a-f0-9]{64}$');

CREATE FUNCTION public.mahshar_worker_discovery_source_update(
  p_run_id uuid,p_source_id text,p_version bigint,p_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; saved public.worker_discovery_sources;
BEGIN
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status<>'running' OR target.deadline_at<=clock_timestamp() THEN RETURN NULL; END IF;
  -- Optimistic version checks fence stale catalog fetches without holding locks during HTTP.
  UPDATE public.worker_discovery_sources SET snapshot=p_snapshot,version=version+1
    WHERE source_id=p_source_id AND version=p_version RETURNING * INTO saved;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_discovery_source_conflict'; END IF;
  RETURN jsonb_build_object('sourceId',saved.source_id,'version',saved.version,'snapshot',saved.snapshot);
END $$;

CREATE FUNCTION public.mahshar_worker_discovery_source_observe(
  p_run_id uuid,p_source_id text,p_version bigint,p_result jsonb,p_record jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; saved public.worker_discovery_sources; existing jsonb; work_key text; position integer;
BEGIN
  IF p_result->>'kind' IS DISTINCT FROM 'candidate' OR jsonb_typeof(p_result->'ordinal') IS DISTINCT FROM 'number'
    OR (p_result->>'ordinal')::integer NOT BETWEEN 0 AND 299
    OR p_result->>'ordinal' IS DISTINCT FROM p_record->>'ordinal'
  THEN RAISE EXCEPTION 'worker_discovery_observation_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  work_key:='candidate:'||(p_result->>'ordinal');
  SELECT compact_result INTO existing FROM public.worker_source_work
    WHERE discovery_batch_id=target.discovery_batch_id AND worker_source_work.claim_key=work_key;
  IF FOUND THEN RETURN existing; END IF;
  IF target.status<>'running' OR target.deadline_at<=clock_timestamp() THEN RETURN NULL; END IF;
  SELECT * INTO saved FROM public.worker_discovery_sources WHERE source_id=p_source_id FOR UPDATE;
  IF NOT FOUND OR saved.version<>p_version THEN RAISE EXCEPTION 'worker_discovery_source_conflict'; END IF;
  position:=(saved.snapshot->>'cursor')::integer;
  IF position>=jsonb_array_length(saved.snapshot->'entries') OR p_record->>'source_id' IS DISTINCT FROM p_source_id
    OR p_record->>'source_revision' IS DISTINCT FROM saved.snapshot->>'revision'
    OR p_record->>'source_record_id' IS DISTINCT FROM saved.snapshot->'entries'->position->>'id'
  THEN RAISE EXCEPTION 'worker_discovery_observation_invalid'; END IF;
  existing:=public.mahshar_worker_materialize_source_work(p_run_id,work_key,'candidate',p_result);
  IF existing IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.worker_candidates(
    discovery_batch_id,ordinal,source_type,source_url,discovered_name,discovered_domain,discovered_product,
    discovered_contract_url,discovered_docs_url,discovered_pricing_url,discovered_contact_url,source_summary,
    source_added_at,source_updated_at,status,reason_code,terminal_at,retention_eligible_at,
    source_id,source_record_id,source_revision
  ) VALUES (
    target.discovery_batch_id,(p_record->>'ordinal')::integer,'api_directory',p_record->>'source_url',
    p_record->>'discovered_name',p_record->>'discovered_domain',p_record->>'discovered_product',
    p_record->>'discovered_contract_url',p_record->>'discovered_docs_url',p_record->>'discovered_pricing_url',
    p_record->>'discovered_contact_url',p_record->>'source_summary',
    (p_record->>'source_added_at')::timestamptz,(p_record->>'source_updated_at')::timestamptz,
    p_record->>'status',p_record->>'reason_code',(p_record->>'terminal_at')::timestamptz,
    (p_record->>'retention_eligible_at')::timestamptz,p_source_id,p_record->>'source_record_id',p_record->>'source_revision'
  ) ON CONFLICT (discovery_batch_id,ordinal) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.worker_candidates WHERE discovery_batch_id=target.discovery_batch_id
    AND ordinal=(p_record->>'ordinal')::integer AND source_id=p_source_id
    AND source_record_id=p_record->>'source_record_id' AND source_revision=p_record->>'source_revision')
  THEN RAISE EXCEPTION 'worker_discovery_candidate_conflict'; END IF;
  UPDATE public.worker_discovery_sources SET version=version+1,
    snapshot=jsonb_set(snapshot||'{"failures":0,"retryAfter":null}'::jsonb,'{cursor}',to_jsonb(position+1))
    WHERE source_id=p_source_id;
  RETURN existing;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_discovery_source_update(uuid,text,bigint,jsonb),
 public.mahshar_worker_discovery_source_observe(uuid,text,bigint,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_discovery_source_update(uuid,text,bigint,jsonb),
 public.mahshar_worker_discovery_source_observe(uuid,text,bigint,jsonb,jsonb) TO service_role;

-- A consumed catalog observation stays pending until existing processing explicitly finalizes it.
-- Reuse the existing batch claim ledger and completion leases; no new queue or scheduler.
CREATE INDEX worker_candidates_pending_source ON public.worker_candidates(created_at,id)
 WHERE status='pending' AND source_id IS NOT NULL AND mail_recovery_kind IS NULL;

CREATE FUNCTION public.mahshar_worker_claim_pending_sources(p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; first_claim integer; ids uuid[];
BEGIN
 SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
 IF target.status<>'running' OR target.deadline_at<=clock_timestamp()
   OR target.qualified_count>=target.qualified_target THEN RETURN '[]'; END IF;
 INSERT INTO public.worker_deferred_claims(discovery_batch_id,claim_key)
   VALUES(target.discovery_batch_id,'pending_sources') ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS first_claim=ROW_COUNT;
 -- One initial slice of five per logical batch. Replays may renew only expired
 -- leases from that same slice, never claim five additional observations.
 WITH locked AS (
  SELECT c.id FROM public.worker_candidates c
  WHERE c.status='pending' AND c.source_id IS NOT NULL AND c.mail_recovery_kind IS NULL
    AND c.discovery_batch_id<>target.discovery_batch_id
    AND NOT EXISTS(SELECT 1 FROM public.worker_runs origin WHERE origin.discovery_batch_id=c.discovery_batch_id
      AND origin.status IN ('queued','running','stop_requested'))
    AND CASE WHEN first_claim=0 THEN c.deferred_claim_batch_id=target.discovery_batch_id
      AND c.processing_lease_expires_at<=clock_timestamp()
    ELSE c.processing_lease_id IS NULL OR c.processing_lease_expires_at<=clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM public.worker_runs owner_run WHERE owner_run.discovery_batch_id=c.deferred_claim_batch_id
        AND owner_run.status IN ('queued','running','stop_requested')) END
  ORDER BY c.created_at,c.id LIMIT 5 FOR UPDATE OF c SKIP LOCKED
 ), leased AS (
  UPDATE public.worker_candidates c SET deferred_claim_batch_id=target.discovery_batch_id,
    processing_lease_id=gen_random_uuid(),processing_lease_expires_at=clock_timestamp()+interval '5 minutes'
  FROM locked WHERE c.id=locked.id RETURNING c.id
 ) SELECT array_agg(id) INTO ids FROM leased;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.id),'[]')
   FROM public.worker_candidates c WHERE c.id=ANY(ids));
END $$;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_pending_sources(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_pending_sources(uuid) TO service_role;
