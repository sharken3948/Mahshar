-- Qualified-target Discovery with bounded source progress and deterministic
-- traction metadata. All objects remain Worker-owned and service-role only.

ALTER TABLE public.worker_control
  ADD COLUMN qualified_target integer NOT NULL DEFAULT 50 CHECK (qualified_target = 50),
  ADD COLUMN raw_candidate_limit integer NOT NULL DEFAULT 300 CHECK (raw_candidate_limit = 300);

ALTER TABLE public.worker_runs
  ADD COLUMN qualified_target integer NOT NULL DEFAULT 50 CHECK (qualified_target = 50),
  ADD COLUMN raw_candidate_limit integer CHECK (raw_candidate_limit IS NULL OR raw_candidate_limit BETWEEN 1 AND 300),
  ADD COLUMN source_cursor integer CHECK (source_cursor IS NULL OR source_cursor BETWEEN 0 AND 300),
  ADD COLUMN source_exhausted boolean NOT NULL DEFAULT false,
  ADD COLUMN completion_reason text CHECK (completion_reason IS NULL OR completion_reason IN (
    'qualified_target_reached', 'source_exhausted', 'hard_limit_reached', 'deadline_reached'
  )),
  ADD COLUMN review_candidate_count integer NOT NULL DEFAULT 0 CHECK (review_candidate_count >= 0),
  ADD COLUMN deferred_count integer NOT NULL DEFAULT 0 CHECK (deferred_count >= 0),
  ADD COLUMN traction_scored_count integer NOT NULL DEFAULT 0 CHECK (traction_scored_count >= 0),
  ADD COLUMN traction_fetch_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.worker_candidates
  ADD COLUMN source_added_at timestamptz,
  ADD COLUMN source_updated_at timestamptz;

ALTER TABLE public.worker_leads
  ADD COLUMN traction_score smallint CHECK (traction_score IS NULL OR traction_score BETWEEN 0 AND 100),
  ADD COLUMN traction_level text CHECK (traction_level IS NULL OR traction_level IN ('low', 'medium', 'high')),
  ADD COLUMN traction_confidence text NOT NULL DEFAULT 'unknown' CHECK (traction_confidence IN ('low', 'medium', 'high', 'unknown')),
  ADD COLUMN last_activity_at timestamptz,
  ADD COLUMN traction_signals text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(traction_signals) <= 8),
  ADD COLUMN traction_concerns text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(traction_concerns) <= 8),
  ADD COLUMN traction_summary text CHECK (traction_summary IS NULL OR length(traction_summary) BETWEEN 1 AND 500),
  ADD COLUMN traction_scored_at timestamptz,
  ADD COLUMN contactability_status text NOT NULL DEFAULT 'unknown' CHECK (contactability_status IN (
    'verified_official_contact', 'official_contact_page', 'official_sales_channel', 'none_found', 'unknown'
  )),
  ADD COLUMN qualification_rank smallint GENERATED ALWAYS AS (CASE
    WHEN qualification_status = 'qualified' THEN 0 WHEN qualification_status = 'review_candidate' THEN 1 ELSE 2 END
  ) STORED,
  ADD COLUMN traction_confidence_rank smallint GENERATED ALWAYS AS (CASE traction_confidence
    WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END
  ) STORED,
  ADD COLUMN contactability_rank smallint GENERATED ALWAYS AS (CASE contactability_status
    WHEN 'verified_official_contact' THEN 0 WHEN 'official_contact_page' THEN 1
    WHEN 'official_sales_channel' THEN 2 WHEN 'none_found' THEN 3 ELSE 4 END
  ) STORED;

CREATE TABLE public.worker_qualified_contributions (
  discovery_batch_id uuid NOT NULL REFERENCES public.worker_runs(id),
  lead_id uuid NOT NULL REFERENCES public.worker_leads(id),
  candidate_id uuid NOT NULL REFERENCES public.worker_candidates(id),
  credited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (discovery_batch_id, lead_id),
  UNIQUE (discovery_batch_id, candidate_id)
);

ALTER TABLE public.worker_qualified_contributions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.worker_qualified_contributions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.worker_qualified_contributions TO service_role;

CREATE INDEX worker_leads_admin_rank ON public.worker_leads(
  qualification_rank, fit_score DESC, traction_score DESC, traction_confidence_rank,
  contactability_rank, created_at DESC, id DESC
) WHERE qualification_status IN ('qualified', 'review_candidate');

DO $worker_target_constraints$
DECLARE constraint_row record;
BEGIN
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_candidates'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%ordinal%99%'
  LOOP EXECUTE format('ALTER TABLE public.worker_candidates DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_runs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ~ '(source_query_count.*60|research_fetch_count.*50|groq_call_count.*20)'
  LOOP EXECUTE format('ALTER TABLE public.worker_runs DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_runs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%batch_size%100%'
  LOOP EXECUTE format('ALTER TABLE public.worker_runs DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_runs'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%status%completed%processed_count%batch_size%'
        OR pg_get_constraintdef(oid) ~ '(duplicate_count|filtered_count|qualified_count|persisted_count).*processed_count')
  LOOP EXECUTE format('ALTER TABLE public.worker_runs DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_budget_claims'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%budget_type%'
  LOOP EXECUTE format('ALTER TABLE public.worker_budget_claims DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
  FOR constraint_row IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.worker_source_work'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%work_kind%' OR pg_get_constraintdef(oid) LIKE '%compact_result%32768%')
  LOOP EXECUTE format('ALTER TABLE public.worker_source_work DROP CONSTRAINT %I', constraint_row.conname); END LOOP;
END $worker_target_constraints$;

ALTER TABLE public.worker_candidates ADD CONSTRAINT worker_candidates_ordinal_target_check CHECK (ordinal BETWEEN 0 AND 299);
ALTER TABLE public.worker_runs
  ADD CONSTRAINT worker_runs_batch_size_target_check CHECK (batch_size BETWEEN 1 AND 300),
  ADD CONSTRAINT worker_runs_target_completion_check CHECK (
    status <> 'completed' OR processed_count = batch_size OR completion_reason IS NOT NULL
  ),
  ADD CONSTRAINT worker_runs_duplicate_nonnegative_check CHECK (duplicate_count >= 0),
  ADD CONSTRAINT worker_runs_filtered_nonnegative_check CHECK (filtered_count >= 0),
  ADD CONSTRAINT worker_runs_qualified_target_bound_check CHECK (
    qualified_target = 50 AND qualified_count BETWEEN 0 AND qualified_target
  ),
  ADD CONSTRAINT worker_runs_persisted_nonnegative_check CHECK (persisted_count >= 0),
  ADD CONSTRAINT worker_runs_source_target_check CHECK (source_query_count BETWEEN 0 AND 301),
  ADD CONSTRAINT worker_runs_research_target_check CHECK (research_fetch_count BETWEEN 0 AND 240),
  ADD CONSTRAINT worker_runs_groq_target_check CHECK (groq_call_count BETWEEN 0 AND 100),
  ADD CONSTRAINT worker_runs_traction_fetch_check CHECK (traction_fetch_count BETWEEN 0 AND 60);
ALTER TABLE public.worker_budget_claims ADD CONSTRAINT worker_budget_claims_type_target_check
  CHECK (budget_type IN ('source', 'research', 'groq', 'traction'));
ALTER TABLE public.worker_source_work
  ADD CONSTRAINT worker_source_work_kind_target_check CHECK (work_kind IN ('provider_plan', 'provider_window', 'candidate')),
  ADD CONSTRAINT worker_source_work_compact_target_check CHECK (
    jsonb_typeof(compact_result) = 'object' AND octet_length(compact_result::text) <= 98304
  );

CREATE OR REPLACE FUNCTION public.mahshar_worker_materialize_source_work(
  p_run_id uuid, p_claim_key text, p_work_kind text, p_compact_result jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.worker_runs; existing_result jsonb; claim_inserted integer;
BEGIN
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$'
    OR p_work_kind NOT IN ('provider_plan', 'provider_window', 'candidate')
    OR p_compact_result IS NULL OR jsonb_typeof(p_compact_result) <> 'object'
    OR octet_length(p_compact_result::text) > 98304 OR p_compact_result->>'kind' IS DISTINCT FROM p_work_kind
    OR (p_work_kind = 'provider_window' AND CASE WHEN jsonb_typeof(p_compact_result->'providers') = 'array'
      THEN jsonb_array_length(p_compact_result->'providers') > 50 ELSE true END)
    OR (p_work_kind = 'provider_plan' AND CASE WHEN jsonb_typeof(p_compact_result->'providers') = 'array'
      THEN jsonb_array_length(p_compact_result->'providers') > 300 ELSE true END)
  THEN RAISE EXCEPTION 'worker_source_work_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  SELECT compact_result INTO existing_result FROM public.worker_source_work
    WHERE discovery_batch_id = target.discovery_batch_id AND claim_key = p_claim_key;
  IF FOUND THEN RETURN existing_result; END IF;
  IF target.status NOT IN ('running', 'stop_requested') OR target.deadline_at <= clock_timestamp() THEN RETURN NULL; END IF;
  INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key)
    VALUES(target.discovery_batch_id,'source',p_claim_key) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claim_inserted = ROW_COUNT;
  IF claim_inserted = 1 THEN
    IF target.source_query_count >= 301 THEN
      DELETE FROM public.worker_budget_claims WHERE discovery_batch_id=target.discovery_batch_id AND budget_type='source' AND claim_key=p_claim_key;
      RETURN NULL;
    END IF;
    UPDATE public.worker_runs SET source_query_count=source_query_count+1, heartbeat_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=p_run_id;
  END IF;
  INSERT INTO public.worker_source_work(discovery_batch_id,claim_key,work_kind,compact_result)
    VALUES(target.discovery_batch_id,p_claim_key,p_work_kind,p_compact_result) ON CONFLICT DO NOTHING;
  SELECT compact_result INTO existing_result FROM public.worker_source_work
    WHERE discovery_batch_id=target.discovery_batch_id AND claim_key=p_claim_key;
  RETURN existing_result;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_deferred_candidates(
  p_run_id uuid,p_claim_key text,p_limit integer DEFAULT 5
) RETURNS TABLE(candidate_id uuid,lease_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.worker_runs; claim_inserted integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'worker_deferred_limit_invalid'; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN RAISE EXCEPTION 'worker_deferred_claim_key_invalid'; END IF;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status NOT IN ('running','stop_requested') OR target.deadline_at<=clock_timestamp()
    OR target.discovery_batch_id<>target.id OR target.qualified_count>=target.qualified_target THEN RETURN; END IF;
  INSERT INTO public.worker_deferred_claims(discovery_batch_id,claim_key)
    VALUES(target.discovery_batch_id,p_claim_key) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claim_inserted=ROW_COUNT;
  IF claim_inserted=0 THEN RETURN; END IF;
  RETURN QUERY WITH locked AS (
    SELECT candidate.id,coalesce(lead.qualification_retry_after,candidate.updated_at) AS retry_after
    FROM public.worker_candidates candidate
    LEFT JOIN public.worker_leads lead ON lead.id=candidate.lead_id
    WHERE candidate.status='deferred' AND candidate.discovery_batch_id<>target.discovery_batch_id
      AND candidate.discovered_domain IS NOT NULL AND candidate.discovered_product IS NOT NULL
      AND (candidate.discovered_contract_url IS NOT NULL OR candidate.discovered_docs_url IS NOT NULL)
      AND ((lead.id IS NULL AND candidate.reason_code IN ('research_budget_exhausted','run_budget_exhausted'))
        OR (lead.qualification_status='deferred' AND coalesce(lead.qualification_retry_after,'-infinity'::timestamptz)<=clock_timestamp()))
      AND (candidate.processing_lease_id IS NULL OR candidate.processing_lease_expires_at<=clock_timestamp())
    ORDER BY retry_after,candidate.id LIMIT p_limit FOR UPDATE OF candidate SKIP LOCKED
  ), eligible AS (
    SELECT id,row_number() OVER (ORDER BY retry_after,id)::smallint AS claim_order,gen_random_uuid() AS new_lease FROM locked
  ), updated AS (
    UPDATE public.worker_candidates candidate SET deferred_claim_batch_id=target.discovery_batch_id,
      deferred_claim_order=eligible.claim_order,processing_lease_id=eligible.new_lease,
      processing_lease_expires_at=clock_timestamp()+interval '5 minutes',processing_attempt=processing_attempt+1,
      updated_at=clock_timestamp() FROM eligible WHERE candidate.id=eligible.id
    RETURNING candidate.id,candidate.processing_lease_id
  ) SELECT updated.id,updated.processing_lease_id FROM updated ORDER BY updated.id;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_claim_budget(p_run_id uuid,p_budget text,p_claim_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.worker_runs;
BEGIN
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status NOT IN ('running','stop_requested') OR target.deadline_at <= clock_timestamp() THEN RETURN false; END IF;
  IF p_claim_key IS NULL OR p_claim_key !~ '^[a-z0-9:_-]{1,120}$' THEN RAISE EXCEPTION 'worker_budget_claim_key_invalid'; END IF;
  IF EXISTS (SELECT 1 FROM public.worker_budget_claims WHERE discovery_batch_id=target.discovery_batch_id AND budget_type=p_budget AND claim_key=p_claim_key)
    THEN RETURN p_budget='source'; END IF;
  IF (p_budget='source' AND target.source_query_count < 301)
    OR (p_budget='research' AND target.research_fetch_count < 240)
    OR (p_budget='groq' AND target.groq_call_count < 100)
    OR (p_budget='traction' AND target.traction_fetch_count < 60)
  THEN
    INSERT INTO public.worker_budget_claims(discovery_batch_id,budget_type,claim_key) VALUES(target.discovery_batch_id,p_budget,p_claim_key);
    UPDATE public.worker_runs SET
      source_query_count=source_query_count+CASE WHEN p_budget='source' THEN 1 ELSE 0 END,
      research_fetch_count=research_fetch_count+CASE WHEN p_budget='research' THEN 1 ELSE 0 END,
      groq_call_count=groq_call_count+CASE WHEN p_budget='groq' THEN 1 ELSE 0 END,
      traction_fetch_count=traction_fetch_count+CASE WHEN p_budget='traction' THEN 1 ELSE 0 END,
      heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_run_id;
    RETURN true;
  END IF;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_create_target_run(p_resume boolean DEFAULT false)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE control_row public.worker_control; source_run public.worker_runs; checkpoint_value jsonb; next_index integer;
  new_run_id uuid:=gen_random_uuid(); created_run public.worker_runs;
BEGIN
  PERFORM public.mahshar_worker_reconcile_stale_run();
  SELECT * INTO control_row FROM public.worker_control WHERE id=1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_control_unavailable'; END IF;
  IF control_row.qualified_target<>50 OR control_row.raw_candidate_limit<>300 THEN RAISE EXCEPTION 'worker_discovery_target_invalid'; END IF;
  IF EXISTS(SELECT 1 FROM public.worker_runs WHERE status IN ('queued','running','stop_requested')) THEN RAISE EXCEPTION 'worker_already_active'; END IF;
  IF p_resume THEN
    checkpoint_value:=control_row.current_checkpoint;
    IF checkpoint_value IS NULL OR control_row.checkpoint_run_id IS NULL
      OR (checkpoint_value->>'version')<>'1' OR (checkpoint_value->>'nextIndex')!~'^[0-9]+$'
      OR (checkpoint_value->>'batchSize')!~'^[0-9]+$' THEN RAISE EXCEPTION 'worker_checkpoint_invalid'; END IF;
    next_index:=(checkpoint_value->>'nextIndex')::integer;
    SELECT * INTO source_run FROM public.worker_runs WHERE id=control_row.checkpoint_run_id FOR UPDATE;
    IF NOT FOUND OR source_run.status NOT IN ('stopped','failed') OR source_run.completion_reason IS NOT NULL
      OR (source_run.raw_candidate_limit IS NOT NULL AND source_run.raw_candidate_limit<>control_row.raw_candidate_limit)
      OR source_run.qualified_target<>control_row.qualified_target
      OR source_run.processed_count<>next_index OR coalesce(source_run.source_cursor,source_run.processed_count)<>next_index
      OR source_run.checkpoint<>checkpoint_value OR next_index<=0
      OR next_index>=coalesce(source_run.raw_candidate_limit,source_run.batch_size)
    THEN RAISE EXCEPTION 'worker_checkpoint_provenance_invalid'; END IF;
  ELSE
    next_index:=0; checkpoint_value:=jsonb_build_object('version',1,'nextIndex',0,'batchSize',control_row.raw_candidate_limit);
  END IF;
  INSERT INTO public.worker_runs(id,status,batch_size,processed_count,discovered_count,duplicate_count,filtered_count,
    qualified_count,persisted_count,checkpoint,heartbeat_at,discovery_batch_id,deadline_at,source_query_count,research_fetch_count,
    groq_call_count,qualified_target,raw_candidate_limit,source_cursor,source_exhausted,review_candidate_count,deferred_count,
    traction_scored_count,traction_fetch_count)
  VALUES(new_run_id,'queued',
    CASE WHEN p_resume THEN coalesce(source_run.raw_candidate_limit,source_run.batch_size) ELSE control_row.raw_candidate_limit END,next_index,
    CASE WHEN p_resume THEN source_run.discovered_count ELSE 0 END,CASE WHEN p_resume THEN source_run.duplicate_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.filtered_count ELSE 0 END,CASE WHEN p_resume THEN source_run.qualified_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.persisted_count ELSE 0 END,checkpoint_value,clock_timestamp(),
    CASE WHEN p_resume THEN source_run.discovery_batch_id ELSE new_run_id END,
    CASE WHEN p_resume THEN source_run.deadline_at ELSE clock_timestamp()+interval '15 minutes' END,
    CASE WHEN p_resume THEN source_run.source_query_count ELSE 0 END,CASE WHEN p_resume THEN source_run.research_fetch_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.groq_call_count ELSE 0 END,control_row.qualified_target,
    CASE WHEN p_resume THEN coalesce(source_run.raw_candidate_limit,source_run.batch_size) ELSE control_row.raw_candidate_limit END,next_index,
    CASE WHEN p_resume THEN source_run.source_exhausted ELSE false END,CASE WHEN p_resume THEN source_run.review_candidate_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.deferred_count ELSE 0 END,CASE WHEN p_resume THEN source_run.traction_scored_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.traction_fetch_count ELSE 0 END) RETURNING * INTO created_run;
  UPDATE public.worker_control SET desired_state='running',current_checkpoint=checkpoint_value,checkpoint_run_id=created_run.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN created_run;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_advance_target_run(
  p_run_id uuid,p_expected_next_index integer,p_next_index integer,p_discovered integer,p_duplicate integer,p_filtered integer,
  p_deferred integer,p_qualified integer,p_review integer,p_persisted integer,p_traction_scored integer,
  p_source_exhausted boolean,p_deadline_reached boolean,p_hard_limit_reached boolean
) RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE control_row public.worker_control; target public.worker_runs; current_index integer; raw_limit integer;
  next_checkpoint jsonb; reason text;
BEGIN
  IF least(p_discovered,p_duplicate,p_filtered,p_deferred,p_qualified,p_review,p_persisted,p_traction_scored)<0 THEN RAISE EXCEPTION 'worker_counter_invalid'; END IF;
  IF p_qualified<>0 THEN RAISE EXCEPTION 'worker_qualified_counter_managed'; END IF;
  SELECT * INTO control_row FROM public.worker_control WHERE id=1 FOR UPDATE;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status IN ('stopped','completed','failed') THEN RETURN target; END IF;
  IF (control_row.desired_state='stopped' OR target.status='stop_requested')
    AND target.qualified_count<target.qualified_target THEN
    UPDATE public.worker_runs SET status='stopped',stopped_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_run_id RETURNING * INTO target;
    UPDATE public.worker_control SET current_checkpoint=target.checkpoint,checkpoint_run_id=target.id,updated_at=clock_timestamp() WHERE id=1;
    RETURN target;
  END IF;
  IF target.status<>'running' THEN RAISE EXCEPTION 'worker_run_not_running'; END IF;
  raw_limit:=coalesce(target.raw_candidate_limit,target.batch_size);
  current_index:=(target.checkpoint->>'nextIndex')::integer;
  IF target.processed_count<>current_index OR coalesce(target.source_cursor,target.processed_count)<>current_index
    OR control_row.checkpoint_run_id IS DISTINCT FROM target.id OR control_row.current_checkpoint IS DISTINCT FROM target.checkpoint
    OR p_expected_next_index<0 OR p_next_index<p_expected_next_index
    OR p_next_index>least(p_expected_next_index+10,raw_limit) THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;
  IF current_index>p_expected_next_index AND current_index>=p_next_index THEN RETURN target; END IF;
  IF p_expected_next_index<>current_index THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;
  IF p_next_index<least(p_expected_next_index+10,raw_limit)
    AND NOT (p_source_exhausted OR p_deadline_reached OR p_hard_limit_reached OR target.qualified_count+p_qualified>=target.qualified_target)
  THEN RAISE EXCEPTION 'worker_checkpoint_conflict'; END IF;
  next_checkpoint:=jsonb_build_object('version',1,'nextIndex',p_next_index,'batchSize',raw_limit);
  IF target.qualified_count>=target.qualified_target THEN reason:='qualified_target_reached';
  ELSIF p_deadline_reached OR target.deadline_at<=clock_timestamp() THEN reason:='deadline_reached';
  ELSIF p_source_exhausted THEN reason:='source_exhausted';
  ELSIF p_hard_limit_reached OR p_next_index>=raw_limit OR target.source_query_count>=301
    OR target.research_fetch_count>=240 OR target.groq_call_count>=100 OR target.traction_fetch_count>=60 THEN reason:='hard_limit_reached'; END IF;
  UPDATE public.worker_runs SET processed_count=p_next_index,source_cursor=p_next_index,discovered_count=discovered_count+p_discovered,
    duplicate_count=duplicate_count+p_duplicate,filtered_count=filtered_count+p_filtered,deferred_count=deferred_count+p_deferred,
    review_candidate_count=review_candidate_count+p_review,
    persisted_count=persisted_count+p_persisted,traction_scored_count=traction_scored_count+p_traction_scored,
    source_exhausted=source_exhausted OR p_source_exhausted,checkpoint=next_checkpoint,
    status=CASE WHEN reason IS NULL THEN status ELSE 'completed' END,completion_reason=reason,
    completed_at=CASE WHEN reason IS NULL THEN completed_at ELSE clock_timestamp() END,
    heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=p_run_id RETURNING * INTO target;
  UPDATE public.worker_control SET desired_state=CASE WHEN reason IS NULL THEN desired_state ELSE 'stopped' END,
    current_checkpoint=next_checkpoint,checkpoint_run_id=target.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_complete_target_run(p_run_id uuid)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target public.worker_runs; raw_limit integer;
BEGIN
  PERFORM 1 FROM public.worker_control WHERE id=1 FOR UPDATE;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
  IF target.status IN ('stopped','completed','failed') THEN RETURN target; END IF;
  raw_limit:=coalesce(target.raw_candidate_limit,target.batch_size);
  IF target.processed_count<raw_limit THEN RAISE EXCEPTION 'worker_run_incomplete'; END IF;
  UPDATE public.worker_runs SET status='completed',completion_reason='hard_limit_reached',completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE id=p_run_id RETURNING * INTO target;
  UPDATE public.worker_control SET desired_state='stopped',current_checkpoint=target.checkpoint,checkpoint_run_id=target.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN target;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_worker_persist_qualification_v2(
  p_run_id uuid,p_candidate_id uuid,p_lease_id uuid,p_provider_id uuid,p_product_id uuid,p_lead_id uuid,p_qualification jsonb,
  p_traction jsonb,p_contactability text,p_model text,p_qualified boolean,p_deferred_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb; target public.worker_runs; candidate public.worker_candidates;
  contribution_inserted integer:=0; counted_qualified boolean:=false; target_reached boolean:=false;
BEGIN
  IF p_traction IS NOT NULL AND (
    jsonb_typeof(p_traction)<>'object' OR (p_traction->>'tractionScore')::numeric NOT BETWEEN 0 AND 100
    OR p_traction->>'tractionLevel' NOT IN ('low','medium','high')
    OR p_traction->>'tractionConfidence' NOT IN ('low','medium','high','unknown')
    OR jsonb_typeof(p_traction->'signals')<>'array' OR jsonb_array_length(p_traction->'signals')>8
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_traction->'signals') value
      WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[a-z0-9_]{1,80}$')
    OR jsonb_typeof(p_traction->'concerns')<>'array' OR jsonb_array_length(p_traction->'concerns')>8
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_traction->'concerns') value
      WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[a-z0-9_]{1,80}$')
    OR coalesce(length(p_traction->>'summary'),0) NOT BETWEEN 1 AND 500
    OR (p_traction->>'lastActivityAt' IS NOT NULL AND length(p_traction->>'lastActivityAt')>64)
  ) THEN RAISE EXCEPTION 'worker_traction_invalid'; END IF;
  IF p_contactability NOT IN ('verified_official_contact','official_contact_page','official_sales_channel','none_found','unknown')
    THEN RAISE EXCEPTION 'worker_contactability_invalid'; END IF;
  result:=public.mahshar_worker_persist_qualification(p_candidate_id,p_lease_id,p_provider_id,p_product_id,p_lead_id,
    p_qualification,p_model,p_qualified,p_deferred_reason);
  IF coalesce((result->>'applied')::boolean,false) AND p_traction IS NOT NULL AND p_qualification IS NOT NULL
    AND result->>'status' IN ('persisted','filtered') THEN
    UPDATE public.worker_leads SET traction_score=(p_traction->>'tractionScore')::smallint,
      traction_level=p_traction->>'tractionLevel',traction_confidence=p_traction->>'tractionConfidence',
      last_activity_at=CASE WHEN p_traction->>'lastActivityAt' IS NULL THEN NULL ELSE (p_traction->>'lastActivityAt')::timestamptz END,
      traction_signals=ARRAY(SELECT left(jsonb_array_elements_text(p_traction->'signals'),80)),
      traction_concerns=ARRAY(SELECT left(jsonb_array_elements_text(p_traction->'concerns'),80)),
      traction_summary=p_traction->>'summary',traction_scored_at=clock_timestamp(),contactability_status=p_contactability,
      updated_at=clock_timestamp() WHERE id=p_lead_id;
  END IF;
  IF coalesce((result->>'applied')::boolean,false) AND result->>'status'='persisted' AND result->>'reasonCode'='qualified' THEN
    SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
    SELECT * INTO candidate FROM public.worker_candidates WHERE id=p_candidate_id;
    IF NOT FOUND OR candidate.lead_id IS DISTINCT FROM p_lead_id
      OR NOT (candidate.discovery_batch_id=target.discovery_batch_id OR candidate.deferred_claim_batch_id=target.discovery_batch_id)
    THEN RAISE EXCEPTION 'worker_qualified_contribution_invalid'; END IF;
    IF target.status IN ('running','stop_requested') AND target.completion_reason IS NULL
      AND target.qualified_count<target.qualified_target THEN
      INSERT INTO public.worker_qualified_contributions(discovery_batch_id,lead_id,candidate_id)
        VALUES(target.discovery_batch_id,p_lead_id,p_candidate_id) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS contribution_inserted=ROW_COUNT;
      IF contribution_inserted=1 THEN
        UPDATE public.worker_runs SET qualified_count=qualified_count+1,
          completion_reason=CASE WHEN qualified_count+1=qualified_target THEN 'qualified_target_reached' ELSE completion_reason END,
          heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=p_run_id AND qualified_count<qualified_target RETURNING * INTO target;
        IF NOT FOUND THEN RAISE EXCEPTION 'worker_qualified_target_conflict'; END IF;
        counted_qualified:=true;
      END IF;
    END IF;
    target_reached:=target.qualified_count>=target.qualified_target;
  END IF;
  RETURN result||jsonb_build_object('countedQualified',counted_qualified,'targetReached',target_reached);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_worker_create_target_run(boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_advance_target_run(uuid,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,boolean,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_complete_target_run(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.mahshar_worker_persist_qualification_v2(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_create_target_run(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_advance_target_run(uuid,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,boolean,boolean,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_complete_target_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_persist_qualification_v2(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text,boolean,text) TO service_role;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,anon,authenticated,service_role;
