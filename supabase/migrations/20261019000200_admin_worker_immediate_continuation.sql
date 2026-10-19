-- New Worker runs receive a 60-minute deadline; historical deadlines and Resume are untouched.
-- Continuous continuation is immediate and stops visibly when its daily cap or work guard blocks it.
-- All existing source, qualification, email, budget, locking and replay functions remain in place.
CREATE OR REPLACE FUNCTION public.mahshar_worker_create_target_run(p_resume boolean DEFAULT false)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
      OR source_run.qualified_target<>control_row.qualified_target OR source_run.processed_count<>next_index
      OR coalesce(source_run.source_cursor,source_run.processed_count)<>next_index OR source_run.checkpoint<>checkpoint_value
      OR next_index<=0 OR next_index>=coalesce(source_run.raw_candidate_limit,source_run.batch_size)
    THEN RAISE EXCEPTION 'worker_checkpoint_provenance_invalid'; END IF;
  ELSE
    next_index:=0; checkpoint_value:=jsonb_build_object('version',1,'nextIndex',0,'batchSize',control_row.raw_candidate_limit);
  END IF;
  INSERT INTO public.worker_runs(id,status,batch_size,processed_count,discovered_count,duplicate_count,filtered_count,
    qualified_count,persisted_count,checkpoint,heartbeat_at,discovery_batch_id,deadline_at,source_query_count,research_fetch_count,
    groq_call_count,qualified_target,raw_candidate_limit,source_cursor,source_exhausted,review_candidate_count,deferred_count,
    traction_scored_count,traction_fetch_count,contact_fetch_count)
  VALUES(new_run_id,'queued',
    CASE WHEN p_resume THEN coalesce(source_run.raw_candidate_limit,source_run.batch_size) ELSE control_row.raw_candidate_limit END,next_index,
    CASE WHEN p_resume THEN source_run.discovered_count ELSE 0 END,CASE WHEN p_resume THEN source_run.duplicate_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.filtered_count ELSE 0 END,CASE WHEN p_resume THEN source_run.qualified_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.persisted_count ELSE 0 END,checkpoint_value,clock_timestamp(),
    CASE WHEN p_resume THEN source_run.discovery_batch_id ELSE new_run_id END,
    CASE WHEN p_resume THEN source_run.deadline_at ELSE clock_timestamp()+interval '60 minutes' END,
    CASE WHEN p_resume THEN source_run.source_query_count ELSE 0 END,CASE WHEN p_resume THEN source_run.research_fetch_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.groq_call_count ELSE 0 END,control_row.qualified_target,
    CASE WHEN p_resume THEN coalesce(source_run.raw_candidate_limit,source_run.batch_size) ELSE control_row.raw_candidate_limit END,next_index,
    CASE WHEN p_resume THEN source_run.source_exhausted ELSE false END,CASE WHEN p_resume THEN source_run.review_candidate_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.deferred_count ELSE 0 END,CASE WHEN p_resume THEN source_run.traction_scored_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.traction_fetch_count ELSE 0 END,
    CASE WHEN p_resume THEN source_run.contact_fetch_count ELSE 0 END) RETURNING * INTO created_run;
  UPDATE public.worker_control SET desired_state='running',current_checkpoint=checkpoint_value,
    checkpoint_run_id=created_run.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN created_run;
END $$;


-- Preserve the 20-run UTC ceiling, parent deduplication and control-row locking.
CREATE OR REPLACE FUNCTION public.mahshar_acquisition_create_next_run(p_epoch uuid,p_parent_run_id uuid)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result public.worker_runs; control_row public.admin_acquisition_control;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control
    WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND OR control_row.operating_mode='canary' OR p_parent_run_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.worker_runs WHERE acquisition_parent_run_id=p_parent_run_id;
  IF FOUND THEN RETURN result; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.worker_runs WHERE id=p_parent_run_id AND status='completed')
    THEN RETURN NULL; END IF;
  -- A lost step response must return the already-created child, not create another run.
  IF control_row.continuation_run_id IS NOT NULL THEN
    SELECT * INTO result FROM public.worker_runs WHERE id=control_row.continuation_run_id;
    IF result.status IN ('queued','running') THEN RETURN NULL; END IF;
    IF result.status IN ('stop_requested','stopped','failed') THEN
      UPDATE public.admin_acquisition_control SET desired_state='stopped',updated_at=clock_timestamp() WHERE id=1;
      RETURN NULL;
    END IF;
  END IF;
  IF (SELECT count(*) FROM public.worker_runs WHERE created_at>=date_trunc('day',clock_timestamp(),'UTC')
    AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')>=20 THEN
    UPDATE public.admin_acquisition_control SET desired_state='stopped',updated_at=clock_timestamp() WHERE id=1;
    RETURN NULL;
  END IF;
  -- A run that made no progress and prepared no acquisition attempts must not
  -- produce an endless chain of empty, immediate continuations.
  IF EXISTS (SELECT 1 FROM public.worker_runs parent WHERE parent.id=p_parent_run_id
    AND parent.completion_reason IN ('source_exhausted','hard_limit_reached','deadline_reached')
    AND parent.processed_count=0
    AND parent.discovered_count=0 AND parent.duplicate_count=0 AND parent.filtered_count=0
    AND parent.qualified_count=0 AND parent.persisted_count=0 AND parent.deferred_count=0
    AND NOT EXISTS (SELECT 1 FROM public.admin_acquisition_attempts attempt WHERE attempt.run_id=parent.id)) THEN
    UPDATE public.admin_acquisition_control SET desired_state='stopped',updated_at=clock_timestamp() WHERE id=1;
    RETURN NULL;
  END IF;
  SELECT * INTO result FROM public.mahshar_worker_create_target_run(false);
  UPDATE public.worker_runs SET acquisition_parent_run_id=p_parent_run_id,
    workflow_run_id=(SELECT workflow_run_id FROM public.worker_runs WHERE id=p_parent_run_id) WHERE id=result.id RETURNING * INTO result;
  UPDATE public.admin_acquisition_control SET continuation_run_id=result.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) TO service_role;
