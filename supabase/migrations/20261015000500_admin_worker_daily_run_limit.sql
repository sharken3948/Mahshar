-- Raise only the daily discovery run ceiling. Existing usage, controls and history are retained.
-- All continuation fencing, parent deduplication, locking and per-run budgets are unchanged.
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
    AND created_at<date_trunc('day',clock_timestamp(),'UTC')+interval '1 day')>=20 THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.mahshar_worker_create_target_run(false);
  UPDATE public.worker_runs SET acquisition_parent_run_id=p_parent_run_id,
    workflow_run_id=(SELECT workflow_run_id FROM public.worker_runs WHERE id=p_parent_run_id) WHERE id=result.id RETURNING * INTO result;
  UPDATE public.admin_acquisition_control SET continuation_run_id=result.id,updated_at=clock_timestamp() WHERE id=1;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_create_next_run(uuid,uuid) TO service_role;
