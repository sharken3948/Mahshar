-- Additive only. No existing candidate/listing data is changed and no work starts.
ALTER TABLE public.api_listings ADD COLUMN free_worker_review jsonb;
CREATE TABLE public.free_worker_bulk_batches (
  id uuid PRIMARY KEY,
  owner_wallet text NOT NULL CHECK(owner_wallet='0x540a0027509b1c9aa0a2c5c65491cc97083e16de'),
  mode text NOT NULL CHECK(mode IN ('FREE','PAID')),
  price numeric(12,6) NOT NULL CHECK(price>=0 AND price<10000),
  rights_confirmed boolean NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  retry_at timestamptz,
  CHECK((mode='FREE' AND price=0) OR (mode='PAID' AND price>0 AND rights_confirmed))
);
CREATE TABLE public.free_worker_bulk_items (
  batch_id uuid NOT NULL REFERENCES public.free_worker_bulk_batches(id),
  candidate_id text NOT NULL REFERENCES public.free_worker_apis(id),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 25),
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','published')),
  stage text NOT NULL DEFAULT 'prepare' CHECK(stage IN ('prepare','analysis','activation','done')),
  listing_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  events jsonb NOT NULL DEFAULT '[]',
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(batch_id,candidate_id), UNIQUE(batch_id,ordinal)
);
CREATE INDEX free_worker_bulk_owner ON public.free_worker_bulk_batches(owner_wallet,authorized_at DESC);
ALTER TABLE public.free_worker_bulk_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.free_worker_bulk_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.free_worker_bulk_batches, public.free_worker_bulk_items FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.free_worker_bulk_batches, public.free_worker_bulk_items TO service_role;

CREATE FUNCTION public.free_worker_bulk_read(p_owner text,p_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT to_jsonb(b) || jsonb_build_object('items',
    (SELECT coalesce(jsonb_agg(to_jsonb(i)-'lease_token' ORDER BY ordinal),'[]') FROM free_worker_bulk_items i WHERE i.batch_id=b.id))
  FROM free_worker_bulk_batches b WHERE owner_wallet=p_owner AND (p_id IS NULL OR id=p_id)
  ORDER BY authorized_at DESC LIMIT 1
$$;

CREATE FUNCTION public.free_worker_bulk_create(p_id uuid,p_owner text,p_mode text,p_price numeric,p_rights boolean,p_inputs jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE saved_batch free_worker_bulk_batches; ids jsonb; old_ids jsonb;
BEGIN
  IF p_owner IS DISTINCT FROM '0x540a0027509b1c9aa0a2c5c65491cc97083e16de'
    OR jsonb_typeof(p_inputs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_inputs) NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid_selection'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  SELECT jsonb_agg(value->'free_worker_candidate_id' ORDER BY ordinal) INTO ids FROM jsonb_array_elements(p_inputs) WITH ORDINALITY a(value,ordinal);
  IF (SELECT count(DISTINCT value->>'free_worker_candidate_id') FROM jsonb_array_elements(p_inputs))<>jsonb_array_length(p_inputs) THEN
    RAISE EXCEPTION 'duplicate_selection'; END IF;
  SELECT * INTO saved_batch FROM free_worker_bulk_batches WHERE id=p_id;
  IF FOUND THEN
    SELECT jsonb_agg(to_jsonb(candidate_id) ORDER BY ordinal) INTO old_ids FROM free_worker_bulk_items WHERE batch_id=p_id;
    IF saved_batch.owner_wallet<>p_owner OR saved_batch.mode<>p_mode OR saved_batch.price<>p_price OR saved_batch.rights_confirmed<>p_rights OR old_ids<>ids THEN
      RAISE EXCEPTION 'authorization_changed'; END IF;
    RETURN free_worker_bulk_read(p_owner,p_id);
  END IF;
  -- One unfinished selection per owner. Do not overwrite a lost browser checkpoint.
  IF EXISTS(SELECT 1 FROM free_worker_bulk_items i JOIN free_worker_bulk_batches b ON b.id=i.batch_id
    WHERE b.owner_wallet=p_owner AND i.status IN ('pending','processing')) THEN RAISE EXCEPTION 'unfinished_batch'; END IF;
  INSERT INTO free_worker_bulk_batches(id,owner_wallet,mode,price,rights_confirmed) VALUES(p_id,p_owner,p_mode,p_price,p_rights);
  INSERT INTO free_worker_bulk_items(batch_id,candidate_id,ordinal,input)
    SELECT p_id,value->>'free_worker_candidate_id',ordinal,value FROM jsonb_array_elements(p_inputs) WITH ORDINALITY a(value,ordinal);
  RETURN free_worker_bulk_read(p_owner,p_id);
END $$;

CREATE FUNCTION public.free_worker_bulk_claim(p_id uuid,p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE item free_worker_bulk_items;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  IF NOT EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND owner_wallet=p_owner) THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  IF EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND retry_at>clock_timestamp()) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM free_worker_bulk_items i JOIN free_worker_bulk_batches b ON b.id=i.batch_id
    WHERE b.owner_wallet=p_owner AND i.status='processing' AND i.lease_until>clock_timestamp()) THEN RETURN NULL; END IF;
  SELECT * INTO item FROM free_worker_bulk_items WHERE batch_id=p_id
    AND (status='pending' OR (status='processing' AND lease_until<=clock_timestamp())) ORDER BY ordinal LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE free_worker_bulk_items SET status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp(),
    events=events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',stage,'event',
      CASE WHEN item.status='processing' THEN 'interrupted_request_reclaimed' ELSE 'claimed' END))
    WHERE batch_id=p_id AND candidate_id=item.candidate_id RETURNING * INTO item;
  RETURN to_jsonb(item);
END $$;

CREATE FUNCTION public.free_worker_bulk_checkpoint(p_id uuid,p_owner text,p_candidate text,p_token uuid,p_stage text,p_listing uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE free_worker_bulk_items i SET stage=p_stage,listing_id=coalesce(p_listing,i.listing_id),updated_at=clock_timestamp(),
    events=events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',p_stage,'event','checkpoint'))
    WHERE batch_id=p_id AND candidate_id=p_candidate AND lease_token=p_token AND status='processing' AND lease_until>clock_timestamp()
      AND EXISTS(SELECT 1 FROM free_worker_bulk_batches b WHERE b.id=i.batch_id AND b.owner_wallet=p_owner);
  RETURN FOUND;
END $$;

CREATE FUNCTION public.free_worker_bulk_finish(p_id uuid,p_owner text,p_candidate text,p_token uuid,p_status text,p_error text DEFAULT NULL,p_retry integer DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_status NOT IN ('published','failed','pending') OR (p_status='pending' AND (p_retry IS NULL OR p_retry<1)) THEN RAISE EXCEPTION 'invalid_outcome'; END IF;
  UPDATE free_worker_bulk_items i SET status=p_status,last_error=left(p_error,1200),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp(),
    stage=CASE WHEN p_status='published' THEN 'done' ELSE stage END,
    events=events||jsonb_build_array(jsonb_build_object('at',clock_timestamp(),'stage',stage,'event',p_status,'error',left(p_error,1200)))
    WHERE batch_id=p_id AND candidate_id=p_candidate AND lease_token=p_token AND status='processing' AND lease_until>clock_timestamp()
      AND EXISTS(SELECT 1 FROM free_worker_bulk_batches b WHERE b.id=i.batch_id AND b.owner_wallet=p_owner);
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_status='pending' THEN UPDATE free_worker_bulk_batches SET retry_at=clock_timestamp()+make_interval(secs=>p_retry) WHERE id=p_id; END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.free_worker_bulk_retry(p_id uuid,p_owner text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bulk:'||p_owner,0));
  IF NOT EXISTS(SELECT 1 FROM free_worker_bulk_batches WHERE id=p_id AND owner_wallet=p_owner) THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  IF EXISTS(SELECT 1 FROM free_worker_bulk_items i JOIN free_worker_bulk_batches b ON b.id=i.batch_id
    WHERE b.owner_wallet=p_owner AND (i.status='processing' AND i.lease_until>clock_timestamp() OR b.id<>p_id AND i.status='pending')) THEN
    RAISE EXCEPTION 'work_in_flight'; END IF;
  UPDATE free_worker_bulk_items SET status='pending',updated_at=clock_timestamp()
    WHERE batch_id=p_id AND status='failed';
  RETURN free_worker_bulk_read(p_owner,p_id);
END $$;

-- Original authorization and already published item outcomes are immutable.
CREATE FUNCTION public.free_worker_bulk_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='free_worker_bulk_batches' THEN
    IF (to_jsonb(NEW)-'retry_at') IS DISTINCT FROM (to_jsonb(OLD)-'retry_at') THEN RAISE EXCEPTION 'authorization_immutable'; END IF;
  ELSE
    IF NEW.batch_id<>OLD.batch_id OR NEW.candidate_id<>OLD.candidate_id OR NEW.ordinal<>OLD.ordinal OR NEW.input<>OLD.input
      OR OLD.status='published' THEN RAISE EXCEPTION 'selection_immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER free_worker_bulk_batch_immutable BEFORE UPDATE ON public.free_worker_bulk_batches FOR EACH ROW EXECUTE FUNCTION public.free_worker_bulk_immutable();
CREATE TRIGGER free_worker_bulk_item_immutable BEFORE UPDATE ON public.free_worker_bulk_items FOR EACH ROW EXECUTE FUNCTION public.free_worker_bulk_immutable();
REVOKE ALL ON FUNCTION public.free_worker_bulk_read(text,uuid), public.free_worker_bulk_create(uuid,text,text,numeric,boolean,jsonb),
  public.free_worker_bulk_claim(uuid,text), public.free_worker_bulk_checkpoint(uuid,text,text,uuid,text,uuid),
  public.free_worker_bulk_finish(uuid,text,text,uuid,text,text,integer), public.free_worker_bulk_retry(uuid,text),public.free_worker_bulk_immutable() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_bulk_read(text,uuid), public.free_worker_bulk_create(uuid,text,text,numeric,boolean,jsonb),
  public.free_worker_bulk_claim(uuid,text), public.free_worker_bulk_checkpoint(uuid,text,text,uuid,text,uuid),
  public.free_worker_bulk_finish(uuid,text,text,uuid,text,text,integer), public.free_worker_bulk_retry(uuid,text),public.free_worker_bulk_immutable() TO service_role;
