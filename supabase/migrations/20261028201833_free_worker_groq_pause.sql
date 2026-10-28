-- Additive Bulk-only manual pause; no existing selection is resumed or modified.
ALTER TABLE public.free_worker_bulk_batches ADD COLUMN pause_reason text
  CHECK (pause_reason IS NULL OR pause_reason='groq_rate_limit');

-- Only operational pause state is mutable; original owner authorization remains frozen.
CREATE OR REPLACE FUNCTION public.free_worker_bulk_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='free_worker_bulk_batches' THEN
    IF (to_jsonb(NEW)-'retry_at'-'pause_reason') IS DISTINCT FROM (to_jsonb(OLD)-'retry_at'-'pause_reason') THEN RAISE EXCEPTION 'authorization_immutable'; END IF;
  ELSE
    IF NEW.batch_id<>OLD.batch_id OR NEW.candidate_id<>OLD.candidate_id OR NEW.ordinal<>OLD.ordinal OR NEW.input<>OLD.input
      OR OLD.status='published' THEN RAISE EXCEPTION 'selection_immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.free_worker_bulk_claim(p_id uuid,p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE item free_worker_bulk_items;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  IF NOT EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND owner_wallet=p_owner) THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  PERFORM free_worker_bulk_expire(p_id,p_owner);
  IF EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND (pause_reason='groq_rate_limit' OR retry_at>clock_timestamp())) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM free_worker_bulk_items i JOIN free_worker_bulk_batches b ON b.id=i.batch_id
    WHERE b.owner_wallet=p_owner AND i.status='processing' AND i.lease_until>clock_timestamp()) THEN RETURN NULL; END IF;
  SELECT * INTO item FROM free_worker_bulk_items WHERE batch_id=p_id AND status='pending' ORDER BY ordinal LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE free_worker_bulk_items SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp(),
    events=events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',stage,'event','claimed'))
    WHERE batch_id=p_id AND candidate_id=item.candidate_id RETURNING * INTO item;
  RETURN to_jsonb(item);
END $$;

-- Atomically release the item lease, retain its draft, and pause the whole saved selection.
CREATE FUNCTION public.free_worker_bulk_pause(p_id uuid,p_owner text,p_candidate text,p_token uuid,p_retry integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE saved boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  saved=free_worker_bulk_finish(p_id,p_owner,p_candidate,p_token,'pending',
    'Groq HTTP 429: rate limit reached. Resume after the saved retry time.',p_retry);
  IF saved AND EXISTS(SELECT 1 FROM free_worker_bulk_items WHERE batch_id=p_id AND candidate_id=p_candidate
    AND status='pending' AND last_error LIKE 'Groq HTTP 429:%') THEN
    UPDATE free_worker_bulk_batches SET pause_reason='groq_rate_limit' WHERE id=p_id AND owner_wallet=p_owner;
    UPDATE free_worker_bulk_items SET events=events||jsonb_build_array(jsonb_build_object(
      'at',clock_timestamp(),'stage',stage,'event','groq_rate_limit','retry_after_seconds',p_retry))
      WHERE batch_id=p_id AND candidate_id=p_candidate;
  END IF;
  RETURN saved;
END $$;

-- Expiry alone never resumes a provider-paused batch. The authenticated owner must act.
CREATE FUNCTION public.free_worker_bulk_resume(p_id uuid,p_owner text,p_retry_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE batch free_worker_bulk_batches;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  SELECT * INTO batch FROM free_worker_bulk_batches WHERE id=p_id AND owner_wallet=p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  IF batch.pause_reason IS NULL THEN RETURN free_worker_bulk_read(p_owner,p_id); END IF;
  IF batch.retry_at IS DISTINCT FROM p_retry_at THEN RAISE EXCEPTION 'groq_pause_changed'; END IF;
  IF batch.retry_at IS NULL OR batch.retry_at>clock_timestamp() THEN RAISE EXCEPTION 'groq_pause_not_elapsed'; END IF;
  UPDATE free_worker_bulk_batches SET pause_reason=NULL WHERE id=p_id;
  -- Version the resume checkpoint so stale browser reads cannot restore an old pause.
  UPDATE free_worker_bulk_items SET updated_at=clock_timestamp(),
    events=events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',stage,'event','resumed'))
    WHERE batch_id=p_id AND status='pending' AND last_error LIKE 'Groq HTTP 429:%';
  RETURN free_worker_bulk_read(p_owner,p_id);
END $$;
REVOKE ALL ON FUNCTION public.free_worker_bulk_pause(uuid,text,text,uuid,integer),public.free_worker_bulk_resume(uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_bulk_pause(uuid,text,text,uuid,integer),public.free_worker_bulk_resume(uuid,text,timestamptz) TO service_role;
