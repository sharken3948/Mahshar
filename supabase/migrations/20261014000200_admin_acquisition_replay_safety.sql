-- Audit remediation only; apply separately after review. Historical migration remains unchanged.
ALTER TABLE public.admin_acquisition_control
  ADD COLUMN continuation_run_id uuid REFERENCES public.worker_runs(id);
ALTER TABLE public.worker_runs
  ADD COLUMN acquisition_parent_run_id uuid UNIQUE REFERENCES public.worker_runs(id);

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_set_state(p_running boolean,p_canary boolean DEFAULT false,p_run_id uuid DEFAULT NULL)
RETURNS public.admin_acquisition_control LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result public.admin_acquisition_control;
BEGIN
  SELECT * INTO result FROM public.admin_acquisition_control WHERE id=1 FOR UPDATE;
  IF p_running AND result.desired_state='running' THEN RAISE EXCEPTION 'acquisition_already_running'; END IF;
  IF p_running AND NOT EXISTS(SELECT 1 FROM public.worker_control c WHERE c.id=1 AND c.desired_state='running')
    THEN RAISE EXCEPTION 'acquisition_start_without_worker'; END IF;
  IF p_running AND p_canary AND (p_run_id IS NULL OR result.canary_used_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.worker_runs WHERE id=p_run_id AND status='queued'))
    THEN RAISE EXCEPTION 'acquisition_canary_unavailable'; END IF;
  UPDATE public.admin_acquisition_control SET desired_state=CASE WHEN p_running THEN 'running' ELSE 'stopped' END,
    epoch=CASE WHEN p_running THEN gen_random_uuid() ELSE epoch END,
    canary_used_at=CASE WHEN p_running AND p_canary THEN clock_timestamp() ELSE canary_used_at END,
    canary_run_id=CASE WHEN p_running AND p_canary THEN p_run_id WHEN p_running THEN NULL ELSE canary_run_id END,
    continuation_run_id=CASE WHEN p_running THEN NULL ELSE continuation_run_id END,
    updated_at=clock_timestamp()
    WHERE id=1 RETURNING * INTO result;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.mahshar_acquisition_create_next_run(p_epoch uuid,p_parent_run_id uuid)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result public.worker_runs; control_row public.admin_acquisition_control;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control
    WHERE id=1 AND desired_state='running' AND epoch=p_epoch FOR UPDATE;
  IF NOT FOUND OR control_row.canary_run_id IS NOT NULL OR p_parent_run_id IS NULL THEN RETURN NULL; END IF;
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
    AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')>=6 THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.mahshar_worker_create_target_run(false);
  UPDATE public.worker_runs SET acquisition_parent_run_id=p_parent_run_id WHERE id=result.id RETURNING * INTO result;
  UPDATE public.admin_acquisition_control SET continuation_run_id=result.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN result;
END $$;

CREATE FUNCTION public.mahshar_acquisition_finish_canary(p_run_id uuid,p_epoch uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE control_row public.admin_acquisition_control; worker_row public.worker_control; target public.worker_runs;
BEGIN
  SELECT * INTO control_row FROM public.admin_acquisition_control WHERE id=1 FOR UPDATE;
  IF control_row.epoch IS DISTINCT FROM p_epoch OR control_row.canary_run_id IS DISTINCT FROM p_run_id
    OR p_run_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO worker_row FROM public.worker_control WHERE id=1 FOR UPDATE;
  SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
  UPDATE public.admin_acquisition_control SET desired_state='stopped',updated_at=clock_timestamp()
    WHERE id=1 AND desired_state='running';
  -- Even after a lost response/retry, this finalizer never stops a later Discovery run.
  IF worker_row.checkpoint_run_id=p_run_id AND target.status IN ('queued','running') THEN
    PERFORM public.mahshar_worker_request_stop();
    RETURN true;
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_finish_canary(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_finish_canary(uuid,uuid) TO service_role;

CREATE FUNCTION public.mahshar_acquisition_stop_epoch(p_epoch uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE public.admin_acquisition_control SET desired_state='stopped',updated_at=clock_timestamp()
    WHERE id=1 AND epoch=p_epoch AND desired_state='running';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_stop_epoch(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_stop_epoch(uuid) TO service_role;

-- The obsolete epoch-only entry point cannot safely identify a retry.
CREATE OR REPLACE FUNCTION public.mahshar_acquisition_create_next_run(p_epoch uuid)
RETURNS public.worker_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RETURN NULL; END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) TO service_role;
