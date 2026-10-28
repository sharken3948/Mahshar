-- Bulk-only deadlines and transactional write fencing. No existing records are changed.
CREATE FUNCTION public.free_worker_bulk_expire(p_id uuid,p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE free_worker_bulk_items i SET
    status=CASE WHEN a.is_active AND a.verified_at IS NOT NULL THEN 'published' ELSE 'failed' END,
    stage=CASE WHEN a.is_active AND a.verified_at IS NOT NULL THEN 'done' ELSE i.stage END,
    listing_id=coalesce(i.listing_id,a.id),
    last_error=CASE WHEN a.is_active AND a.verified_at IS NOT NULL THEN NULL ELSE 'TIMEOUT: API processing exceeded 60 seconds. Draft and completed review retained; retry manually.' END,
    lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp(),
    events=i.events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',i.stage,'event',
      CASE WHEN a.is_active AND a.verified_at IS NOT NULL THEN 'published_reconciled' ELSE 'timeout' END))
    FROM free_worker_bulk_batches b LEFT JOIN api_listings a ON a.seller_wallet=b.owner_wallet
      AND a.free_worker_candidate_id IN (SELECT candidate_id FROM free_worker_bulk_items WHERE batch_id=p_id)
    WHERE i.batch_id=p_id AND b.id=i.batch_id AND b.owner_wallet=p_owner
      AND a.free_worker_candidate_id=i.candidate_id AND i.status='processing' AND i.lease_until<=clock_timestamp();
  -- An interrupted preparation can expire before any draft exists.
  UPDATE free_worker_bulk_items i SET status='failed',last_error='TIMEOUT: API processing exceeded 60 seconds. Draft and completed review retained; retry manually.',
    lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp(),
    events=events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',stage,'event','timeout'))
    WHERE batch_id=p_id AND status='processing' AND lease_until<=clock_timestamp()
      AND EXISTS(SELECT 1 FROM free_worker_bulk_batches b WHERE b.id=i.batch_id AND b.owner_wallet=p_owner);
END $$;

CREATE OR REPLACE FUNCTION public.free_worker_bulk_claim(p_id uuid,p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE item free_worker_bulk_items;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  IF NOT EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND owner_wallet=p_owner) THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  PERFORM free_worker_bulk_expire(p_id,p_owner);
  IF EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND retry_at>clock_timestamp()) THEN RETURN NULL; END IF;
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

CREATE OR REPLACE FUNCTION public.free_worker_bulk_finish(p_id uuid,p_owner text,p_candidate text,p_token uuid,p_status text,p_error text DEFAULT NULL,p_retry integer DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE item free_worker_bulk_items;
BEGIN
  IF p_status NOT IN ('published','failed','pending') OR (p_status='pending' AND (p_retry IS NULL OR p_retry<1)) THEN RAISE EXCEPTION 'invalid_outcome'; END IF;
  SELECT i.* INTO item FROM free_worker_bulk_items i WHERE batch_id=p_id AND candidate_id=p_candidate
    AND EXISTS(SELECT 1 FROM free_worker_bulk_batches b WHERE b.id=i.batch_id AND b.owner_wallet=p_owner) FOR UPDATE;
  IF NOT FOUND OR item.lease_token IS DISTINCT FROM p_token OR item.status<>'processing' THEN RETURN false; END IF;
  IF item.lease_until<=clock_timestamp() THEN PERFORM free_worker_bulk_expire(p_id,p_owner); RETURN true; END IF;
  IF p_status='published' AND NOT EXISTS(SELECT 1 FROM api_listings WHERE free_worker_candidate_id=p_candidate AND seller_wallet=p_owner AND is_active AND verified_at IS NOT NULL) THEN RAISE EXCEPTION 'publication_not_confirmed'; END IF;
  UPDATE free_worker_bulk_items SET status=p_status,last_error=left(p_error,1200),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp(),
    stage=CASE WHEN p_status='published' THEN 'done' ELSE stage END,
    events=events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',stage,'event',
      CASE WHEN p_error LIKE 'TIMEOUT:%' THEN 'timeout' ELSE p_status END,'error',left(p_error,1200)))
    WHERE batch_id=p_id AND candidate_id=p_candidate;
  IF p_status='pending' THEN UPDATE free_worker_bulk_batches SET retry_at=clock_timestamp()+make_interval(secs=>p_retry) WHERE id=p_id; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.free_worker_bulk_retry(p_id uuid,p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  IF NOT EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND owner_wallet=p_owner) THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  PERFORM free_worker_bulk_expire(p_id,p_owner);
  IF EXISTS(SELECT 1 FROM free_worker_bulk_items i JOIN free_worker_bulk_batches b ON b.id=i.batch_id
    WHERE b.owner_wallet=p_owner AND (i.status='processing' AND i.lease_until>clock_timestamp() OR b.id<>p_id AND i.status='pending')) THEN RAISE EXCEPTION 'work_in_flight'; END IF;
  UPDATE free_worker_bulk_items SET status='pending',updated_at=clock_timestamp() WHERE batch_id=p_id AND status='failed';
  RETURN free_worker_bulk_read(p_owner,p_id);
END $$;

-- Only in-process Bulk List service clients carry this context. Headers from the
-- browser are never forwarded here. Ordinary Seller and recheck writes are unchanged.
CREATE FUNCTION public.free_worker_bulk_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE context jsonb; item free_worker_bulk_items;
BEGIN
  context=(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-mahshar-bulk-attempt')::jsonb;
  IF context IS NULL THEN RETURN NEW; END IF;
  SELECT i.* INTO item FROM free_worker_bulk_items i JOIN free_worker_bulk_batches b ON b.id=i.batch_id
    WHERE i.batch_id=(context->>'batch')::uuid AND i.candidate_id=context->>'candidate'
      AND b.owner_wallet=NEW.seller_wallet FOR UPDATE OF i;
  IF NOT FOUND OR item.candidate_id IS DISTINCT FROM NEW.free_worker_candidate_id
    OR item.status<>'processing' OR item.lease_token IS DISTINCT FROM (context->>'token')::uuid
    OR item.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'TIMEOUT: Bulk attempt expired or superseded'; END IF;
  RETURN NEW;
END $$;
-- Check at transaction completion, including time spent waiting on other listing
-- guards/locks. A late transaction rolls back its listing and candidate changes.
CREATE CONSTRAINT TRIGGER free_worker_bulk_write_guard AFTER INSERT OR UPDATE ON public.api_listings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.free_worker_bulk_write_guard();
REVOKE ALL ON FUNCTION public.free_worker_bulk_expire(uuid,text),public.free_worker_bulk_write_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_bulk_expire(uuid,text),public.free_worker_bulk_write_guard() TO service_role;
