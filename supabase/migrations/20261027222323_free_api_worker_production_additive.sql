-- Production first install only. No legacy cleanup, shared data writes or automatic start.
-- Final definitions from isolated Phases 1–3; fail if installation already exists.
CREATE TABLE public.free_worker_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id=1),
  status text NOT NULL DEFAULT 'stopped' CHECK(status IN ('running','stopped','completed')),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  discovery_done boolean NOT NULL DEFAULT false,
  cooldowns jsonb NOT NULL DEFAULT '{}',
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.free_worker_state(id) VALUES (1);
CREATE TABLE public.free_worker_apis (
  id text PRIMARY KEY CHECK(length(id)=64),
  provider_id text NOT NULL,
  name text NOT NULL,
  documentation_url text NOT NULL,
  lead jsonb NOT NULL,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  token uuid,
  lease_until timestamptz,
  claim_generation uuid,
  last_generation uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX free_worker_document_identity ON public.free_worker_apis(documentation_url);
CREATE INDEX free_worker_due ON public.free_worker_apis(retry_at,id);
ALTER TABLE public.free_worker_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.free_worker_apis ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.free_worker_state, public.free_worker_apis FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.free_worker_state,public.free_worker_apis TO service_role;

CREATE FUNCTION public.free_worker_admit(p_leads jsonb) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  INSERT INTO public.free_worker_apis(id,provider_id,name,documentation_url,lead)
  SELECT item->>'id',item->>'providerId',item->>'name',item->>'docs',item
    FROM jsonb_array_elements(p_leads) item
  ON CONFLICT DO NOTHING
$$;

CREATE FUNCTION public.free_worker_control(p_action text) RETURNS public.free_worker_state
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.free_worker_state;
BEGIN
  SELECT * INTO s FROM public.free_worker_state WHERE id=1 FOR UPDATE;
  IF p_action NOT IN ('start','stop','resume') THEN RAISE EXCEPTION 'invalid_action'; END IF;
  IF p_action<>'stop' AND s.status='running' THEN RAISE EXCEPTION 'already_running'; END IF;
  UPDATE public.free_worker_state SET status=CASE WHEN p_action='stop' THEN 'stopped' ELSE 'running' END,
    generation=CASE WHEN p_action='stop' THEN generation ELSE gen_random_uuid() END,
    discovery_done=CASE WHEN p_action='start' THEN false ELSE discovery_done END,
    error=NULL,updated_at=clock_timestamp() WHERE id=1 RETURNING * INTO s;
  RETURN s;
END $$;
CREATE FUNCTION public.free_worker_claim(p_generation uuid) RETURNS SETOF public.free_worker_apis
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  -- Lock the control row so a concurrent Stop fences subsequent claims.
  PERFORM 1 FROM public.free_worker_state WHERE id=1 AND status='running' AND generation=p_generation FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY WITH chosen AS (
    SELECT id FROM public.free_worker_apis
    WHERE (result IS NULL OR retry_at<=clock_timestamp())
      AND last_generation IS DISTINCT FROM p_generation
      AND (token IS NULL OR lease_until<clock_timestamp())
    ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 3
  ) UPDATE public.free_worker_apis a SET token=gen_random_uuid(),lease_until=clock_timestamp()+interval '15 minutes',
    claim_generation=p_generation,attempts=attempts+1,updated_at=clock_timestamp()
    FROM chosen c WHERE a.id=c.id RETURNING a.*;
END $$;
CREATE FUNCTION public.free_worker_save(p_id text,p_token uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.free_worker_apis SET result=p_result,retry_at=(p_result->>'retryAt')::timestamptz,
    last_generation=claim_generation,token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id=p_id AND token=p_token;
  RETURN FOUND;
END $$;
CREATE FUNCTION public.free_worker_finish(p_generation uuid,p_cooldowns jsonb,p_error text DEFAULT NULL)
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
    WHERE (result IS NULL OR retry_at<=clock_timestamp()) AND last_generation IS DISTINCT FROM p_generation
      AND (token IS NULL OR lease_until<clock_timestamp())) INTO remains;
  SELECT EXISTS(SELECT 1 FROM public.free_worker_apis WHERE retry_at IS NOT NULL OR token IS NOT NULL) INTO retryable;
  UPDATE public.free_worker_state SET cooldowns=pauses,
    status=CASE WHEN generation<>p_generation OR status<>'running' THEN status
      WHEN p_error IS NOT NULL THEN 'stopped' WHEN remains THEN 'running'
      WHEN retryable OR NOT discovery_done THEN 'stopped' ELSE 'completed' END,
    error=CASE WHEN generation=p_generation THEN coalesce(p_error,error) ELSE error END,
    discovery_done=CASE WHEN generation=p_generation AND p_error LIKE 'No discovery%' THEN false ELSE discovery_done END,
    updated_at=clock_timestamp() WHERE id=1 RETURNING * INTO s;
  RETURN s;
END $$;
REVOKE ALL ON FUNCTION public.free_worker_admit(jsonb),public.free_worker_control(text),public.free_worker_claim(uuid),
  public.free_worker_save(text,uuid,jsonb),public.free_worker_finish(uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_admit(jsonb),public.free_worker_control(text),public.free_worker_claim(uuid),
  public.free_worker_save(text,uuid,jsonb),public.free_worker_finish(uuid,jsonb,text) TO service_role;


-- Additive, Worker-only Phase 1. Apply through the normal deployment process; no shared data writes.
ALTER TABLE public.free_worker_apis ADD COLUMN removed_at timestamptz, ADD COLUMN removed_by text,
  ADD COLUMN completed_at timestamptz, ADD COLUMN saved_inventory jsonb;
ALTER TABLE public.free_worker_state ADD COLUMN inventory jsonb;
UPDATE public.free_worker_apis SET completed_at=updated_at WHERE result IS NOT NULL AND retry_at IS NULL;
DROP FUNCTION public.free_worker_claim(uuid);
CREATE OR REPLACE FUNCTION public.free_worker_control(p_action text) RETURNS public.free_worker_state
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.free_worker_state;
BEGIN
  SELECT * INTO s FROM public.free_worker_state WHERE id=1 FOR UPDATE;
  IF p_action NOT IN ('start','stop','resume') THEN RAISE EXCEPTION 'invalid_action'; END IF;
  IF p_action<>'stop' AND s.status='running' THEN RAISE EXCEPTION 'already_running'; END IF;
  IF p_action<>'stop' AND EXISTS(SELECT 1 FROM public.free_worker_apis WHERE token IS NOT NULL AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'work_in_flight'; END IF;
  UPDATE public.free_worker_state SET status=CASE WHEN p_action='stop' THEN 'stopped' ELSE 'running' END,
    generation=CASE WHEN p_action='stop' THEN generation ELSE gen_random_uuid() END,
    discovery_done=true,
    error=NULL,updated_at=clock_timestamp() WHERE id=1 RETURNING * INTO s;
  RETURN s;
END $$;
CREATE OR REPLACE FUNCTION public.free_worker_claim(p_generation uuid, p_limit integer DEFAULT 3) RETURNS SETOF public.free_worker_apis
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  -- Lock the control row so a concurrent Stop fences subsequent claims.
  PERFORM 1 FROM public.free_worker_state WHERE id=1 AND status='running' AND generation=p_generation FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY WITH chosen AS (
    SELECT id FROM public.free_worker_apis
    WHERE removed_at IS NULL AND completed_at IS NULL AND (result IS NULL OR retry_at IS NULL OR retry_at<=clock_timestamp())
      AND last_generation IS DISTINCT FROM p_generation
      AND (token IS NULL OR lease_until<clock_timestamp())
    ORDER BY id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,3))
  ) UPDATE public.free_worker_apis a SET token=gen_random_uuid(),lease_until=clock_timestamp()+interval '15 minutes',
    claim_generation=p_generation,attempts=attempts+1,updated_at=clock_timestamp()
    FROM chosen c WHERE a.id=c.id RETURNING a.*;
END $$;
CREATE OR REPLACE FUNCTION public.free_worker_save(p_id text,p_token uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.free_worker_apis SET result=p_result,retry_at=(p_result->>'retryAt')::timestamptz,
    completed_at=CASE WHEN p_result->>'retryAt' IS NULL THEN clock_timestamp() ELSE NULL END,
    last_generation=claim_generation,token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id=p_id AND token=p_token;
  RETURN FOUND;
END $$;
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
    WHERE removed_at IS NULL AND completed_at IS NULL AND (result IS NULL OR retry_at IS NULL OR retry_at<=clock_timestamp()) AND last_generation IS DISTINCT FROM p_generation
      AND (token IS NULL OR lease_until<clock_timestamp())) INTO remains;
  SELECT EXISTS(SELECT 1 FROM public.free_worker_apis WHERE removed_at IS NULL AND completed_at IS NULL AND (retry_at IS NOT NULL OR token IS NOT NULL)) INTO retryable;
  UPDATE public.free_worker_state SET cooldowns=pauses,
    status=CASE WHEN generation<>p_generation OR status<>'running' THEN status
      WHEN p_error IS NOT NULL THEN 'stopped' WHEN remains THEN 'running'
      WHEN retryable OR NOT discovery_done THEN 'stopped' ELSE 'completed' END,
    error=CASE WHEN generation=p_generation THEN coalesce(p_error,error) ELSE error END,
    updated_at=clock_timestamp() WHERE id=1 RETURNING * INTO s;
  RETURN s;
END $$;

CREATE FUNCTION public.free_worker_release(p_id text,p_token uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path=public,pg_temp AS $$
  UPDATE public.free_worker_apis SET token=NULL,lease_until=NULL WHERE id=p_id AND token=p_token
$$;
-- The offline importer preserves completed evaluation snapshots verbatim, including failures.
-- Re-imports cannot overwrite newer work, tombstones, or existing evidence.
CREATE FUNCTION public.free_worker_import(p_rows jsonb,p_inventory jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.free_worker_state WHERE id=1 FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.free_worker_state WHERE status='running') THEN RAISE EXCEPTION 'already_running'; END IF;
  INSERT INTO public.free_worker_apis(id,provider_id,name,documentation_url,lead,result,attempts,retry_at,completed_at,saved_inventory)
  SELECT r->'lead'->>'id',r->'lead'->>'providerId',r->'lead'->>'name',r->'lead'->>'docs',r->'lead',
    nullif(r->'result','null'::jsonb),coalesce((r->>'attempts')::integer,0),(r->>'retryAt')::timestamptz,
    CASE WHEN r->'result' IS NOT NULL AND r->'result'<>'null'::jsonb THEN clock_timestamp() END,r->'savedInventory'
  FROM jsonb_array_elements(p_rows) r ON CONFLICT DO NOTHING;
  -- A previously admitted but unprocessed identity may receive its saved evaluation.
  UPDATE public.free_worker_apis a SET lead=r->'lead',result=r->'result',
    attempts=greatest(a.attempts,coalesce((r->>'attempts')::integer,0)),
    retry_at=(r->>'retryAt')::timestamptz,completed_at=clock_timestamp(),saved_inventory=r->'savedInventory'
    FROM jsonb_array_elements(p_rows) r
    WHERE a.id=r->'lead'->>'id' AND a.result IS NULL AND a.token IS NULL AND a.removed_at IS NULL
      AND r->'result' IS NOT NULL AND r->'result'<>'null'::jsonb;
  UPDATE public.free_worker_state SET inventory=p_inventory,discovery_done=true,updated_at=clock_timestamp() WHERE id=1;
END $$;
CREATE FUNCTION public.free_worker_remove(p_ids text[],p_owner text) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE count_removed integer;
BEGIN
  IF p_owner<>'0x540a0027509b1c9aa0a2c5c65491cc97083e16de' THEN RAISE EXCEPTION 'owner_wallet_required'; END IF;
  -- Retain rows and evidence. Suppress endpoint aliases as well as the selected identity.
  WITH selected AS (SELECT id,result->>'endpoint' endpoint FROM public.free_worker_apis
    WHERE id=ANY(p_ids) AND removed_at IS NULL AND result->>'technical'='PASSED'
      AND result->>'freeAccess'='VERIFIED' AND (result->>'termsChecked')::boolean
      AND result->>'permission' IN ('ALLOWED','UNKNOWN','REVIEW_REQUIRED')), changed AS (
  UPDATE public.free_worker_apis a SET removed_at=clock_timestamp(),removed_by=p_owner
    WHERE a.removed_at IS NULL AND EXISTS(SELECT 1 FROM selected s WHERE a.id=s.id OR a.result->>'endpoint'=s.endpoint) RETURNING a.id)
  SELECT count(*) INTO count_removed FROM changed WHERE id=ANY(p_ids);
  RETURN count_removed;
END $$;
REVOKE ALL ON FUNCTION public.free_worker_claim(uuid,integer),public.free_worker_release(text,uuid),
  public.free_worker_import(jsonb,jsonb),public.free_worker_remove(text[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_claim(uuid,integer),public.free_worker_release(text,uuid),
  public.free_worker_import(jsonb,jsonb),public.free_worker_remove(text[],text) TO service_role;
CREATE FUNCTION public.free_worker_checkpoint(p_id text,p_token uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.free_worker_apis SET result=p_result,updated_at=clock_timestamp()
    WHERE id=p_id AND token=p_token;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.free_worker_checkpoint(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_checkpoint(text,uuid,jsonb) TO service_role;


-- Worker-only additive discovery checkpoints and duplicate identities. No Marketplace writes.
ALTER TABLE public.free_worker_state ADD COLUMN discovery jsonb, ADD COLUMN discovery_pending jsonb NOT NULL DEFAULT '[]';
ALTER TABLE public.free_worker_apis ADD COLUMN identity_keys text[] NOT NULL DEFAULT '{}';
-- A documentation portal can describe distinct explicitly identified services.
DROP INDEX public.free_worker_document_identity;
CREATE INDEX free_worker_document_lookup ON public.free_worker_apis(documentation_url);
CREATE FUNCTION public.free_worker_keys(l jsonb,r jsonb DEFAULT NULL) RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT array_remove(ARRAY[
    'id:'||(l->>'id'),
    'service:'||(l->>'serviceIdentity'),
    'name:'||lower(l->>'providerId')||':'||regexp_replace(lower(regexp_replace(l->>'name','\s+api$','','i')),'[^[:alnum:]]','','g'),
    'doc:'||regexp_replace(regexp_replace(l->>'docs','#[^#]*$',''),'/+$',''),
    'doc:'||regexp_replace(regexp_replace(r->>'docs','#[^#]*$',''),'/+$',''),
    CASE WHEN l->>'docs' ~* '^https://github.com/[^/]+/[^/]+/blob/[^/]+/docs/(readme|index)\.md([?#].*)?$'
      THEN 'repo-doc:'||lower(substring(l->>'docs' from '^https://github.com/([^/]+/[^/]+)/'))||':docs' END,
    'endpoint:'||(r->>'endpoint'),
    CASE WHEN coalesce(r->>'endpoint',l->>'docs') ~ '^https://api\.met\.no/weatherapi/[^/]+/'
      THEN 'service:met.no:'||split_part(regexp_replace(coalesce(r->>'endpoint',l->>'docs'),'^https://api\.met\.no/weatherapi/',''), '/',1) END
  ],NULL) || ARRAY(
    SELECT DISTINCT 'endpoint:'||url FROM (
      SELECT r->>'endpoint' url UNION ALL SELECT jsonb_array_elements_text(coalesce(l->'endpoints','[]'))
    ) endpoints WHERE url IS NOT NULL
  ) || ARRAY(
    -- Documented sample parameters do not create a new service at the same resource.
    -- Root/query-dispatched endpoints have no resource identity here.
    SELECT DISTINCT 'resource:'||regexp_replace(url,'[?#].*$','') FROM (
      SELECT r->>'endpoint' url UNION ALL SELECT jsonb_array_elements_text(coalesce(l->'endpoints','[]'))
    ) endpoints WHERE url ~ '^https://[^/]+/[^?]+' AND url !~ '^https://[^/]+/(api/?)?([?].*)?$'
      AND url !~* '[?&](service|action|method|api|module|function|operation|resource)='
  )
$$;
-- Include every historical alias, failed/excluded row and removal tombstone in admission checks.
UPDATE public.free_worker_apis a SET identity_keys=(
  SELECT array_agg(DISTINCT key) FROM (
    SELECT unnest(public.free_worker_keys(a.lead,a.result)) key
    UNION ALL SELECT unnest(public.free_worker_keys(v->'lead',v->'result'))
      FROM jsonb_array_elements(coalesce(a.saved_inventory->'aliases','[]')) v
    UNION ALL SELECT unnest(public.free_worker_keys(a.saved_inventory->'original'->'lead',a.saved_inventory->'original'->'result'))
  ) keys WHERE key IS NOT NULL);
CREATE INDEX free_worker_identity_keys ON public.free_worker_apis USING gin(identity_keys);
CREATE FUNCTION public.free_worker_set_keys() RETURNS trigger
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
  RETURN NEW;
END $$;
CREATE TRIGGER free_worker_identity BEFORE INSERT OR UPDATE OF lead,result,saved_inventory ON public.free_worker_apis
  FOR EACH ROW EXECUTE FUNCTION public.free_worker_set_keys();
CREATE OR REPLACE FUNCTION public.free_worker_admit(p_leads jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE item jsonb;
BEGIN
  PERFORM 1 FROM public.free_worker_state WHERE id=1 FOR UPDATE;
  FOR item IN SELECT * FROM jsonb_array_elements(p_leads) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.free_worker_apis WHERE identity_keys && public.free_worker_keys(item)
      AND (coalesce(lead->>'serviceIdentity','')='' OR coalesce(item->>'serviceIdentity','')='' OR lead->>'serviceIdentity'=item->>'serviceIdentity' OR id=item->>'id')) THEN
      INSERT INTO public.free_worker_apis(id,provider_id,name,documentation_url,lead)
        VALUES(item->>'id',item->>'providerId',item->>'name',item->>'docs',item) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
-- Source position, pending catalogue metadata and admission commit together.
CREATE FUNCTION public.free_worker_discovery_save(p_generation uuid,p_progress jsonb,p_pending jsonb,p_leads jsonb,p_source text,p_expected jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE before_count integer; after_count integer; stats jsonb;
BEGIN
  PERFORM 1 FROM public.free_worker_state WHERE id=1 AND status='running' AND generation=p_generation AND discovery IS NOT DISTINCT FROM p_expected FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_expected->>'refreshAt' IS NOT NULL AND p_progress->>'refreshAt' IS NULL THEN
    -- A later source pass may retry unfinished work after the real provider pause.
    UPDATE public.free_worker_apis SET last_generation=NULL WHERE completed_at IS NULL AND removed_at IS NULL
      AND retry_at<=clock_timestamp() AND token IS NULL;
  END IF;
  SELECT count(*) INTO before_count FROM public.free_worker_apis;
  PERFORM public.free_worker_admit(p_leads);
  SELECT count(*) INTO after_count FROM public.free_worker_apis;
  IF p_source IS NOT NULL THEN
    stats=p_progress->'stats'->p_source;
    stats=jsonb_set(stats,'{admitted}',to_jsonb(coalesce((stats->>'admitted')::integer,0)+after_count-before_count));
    stats=jsonb_set(stats,'{duplicates}',to_jsonb(coalesce((stats->>'duplicates')::integer,0)+jsonb_array_length(p_leads)-(after_count-before_count)));
    p_progress=jsonb_set(p_progress,ARRAY['stats',p_source],stats);
  END IF;
  UPDATE public.free_worker_state SET discovery=p_progress,discovery_pending=p_pending,
    discovery_done=(p_progress->>'refreshAt' IS NOT NULL),updated_at=clock_timestamp() WHERE id=1;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.free_worker_control(p_action text) RETURNS public.free_worker_state
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.free_worker_state;
BEGIN
  SELECT * INTO s FROM public.free_worker_state WHERE id=1 FOR UPDATE;
  IF p_action NOT IN ('start','stop','resume') THEN RAISE EXCEPTION 'invalid_action'; END IF;
  IF p_action<>'stop' AND s.status='running' THEN RAISE EXCEPTION 'already_running'; END IF;
  IF p_action<>'stop' AND EXISTS(SELECT 1 FROM public.free_worker_apis WHERE token IS NOT NULL AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'work_in_flight'; END IF;
  UPDATE public.free_worker_state SET status=CASE WHEN p_action='stop' THEN 'stopped' ELSE 'running' END,
    generation=CASE WHEN p_action='stop' THEN generation ELSE gen_random_uuid() END,
    discovery=CASE WHEN p_action='start' THEN NULL ELSE discovery END,
    discovery_pending=CASE WHEN p_action='start' THEN '[]'::jsonb ELSE discovery_pending END,
    discovery_done=CASE WHEN p_action='start' THEN false ELSE discovery_done END,
    error=NULL,updated_at=clock_timestamp() WHERE id=1 RETURNING * INTO s;
  -- Do not serialize the pending catalogue into the public control response.
  s.discovery_pending='[]'; RETURN s;
END $$;
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
    WHERE removed_at IS NULL AND completed_at IS NULL AND (result IS NULL OR retry_at IS NULL OR retry_at<=clock_timestamp()) AND last_generation IS DISTINCT FROM p_generation
      AND (token IS NULL OR lease_until<clock_timestamp())) INTO remains;
  SELECT EXISTS(SELECT 1 FROM public.free_worker_apis WHERE removed_at IS NULL AND completed_at IS NULL AND (retry_at IS NOT NULL OR token IS NOT NULL)) INTO retryable;
  UPDATE public.free_worker_state SET cooldowns=pauses,
    status=CASE WHEN generation<>p_generation OR status<>'running' THEN status
      WHEN p_error IS NOT NULL THEN 'stopped' WHEN remains OR NOT discovery_done OR discovery IS NOT NULL THEN 'running'
      WHEN retryable OR NOT discovery_done THEN 'stopped' ELSE 'completed' END,
    error=CASE WHEN generation=p_generation THEN coalesce(p_error,error) ELSE error END,
    updated_at=clock_timestamp() WHERE id=1 RETURNING * INTO s;
  RETURN s;
END $$;

REVOKE ALL ON FUNCTION public.free_worker_keys(jsonb,jsonb),public.free_worker_set_keys(),public.free_worker_discovery_save(uuid,jsonb,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_keys(jsonb,jsonb),public.free_worker_set_keys(),public.free_worker_discovery_save(uuid,jsonb,jsonb,jsonb,text,jsonb) TO service_role;


-- Additive only. Apply through normal deployment review; never run against Production here.
ALTER TABLE public.free_worker_apis ADD COLUMN listing_id uuid, ADD COLUMN published_at timestamptz;
ALTER TABLE public.api_listings ADD COLUMN free_worker_candidate_id text UNIQUE REFERENCES public.free_worker_apis(id);

-- Association and Ready removal commit with the Seller listing, including response-loss retries.
CREATE FUNCTION public.free_worker_listing_guard() RETURNS trigger
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
  IF NEW.price_per_call > 0 AND (candidate.result->>'permission' IS DISTINCT FROM 'ALLOWED'
    OR jsonb_array_length(coalesce(candidate.result->'evidence','[]'::jsonb)) = 0) THEN
    RAISE EXCEPTION 'Saved evidence does not establish paid API proxy/resale rights';
  END IF;
  IF NEW.is_active AND NEW.verified_at IS NULL THEN RAISE EXCEPTION 'Verify the endpoint before activation'; END IF;
  UPDATE public.free_worker_apis SET listing_id = NEW.id,
    published_at = CASE WHEN NEW.is_active THEN coalesce(published_at, now()) ELSE published_at END
    WHERE id = candidate.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.free_worker_listing_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_listing_guard() TO service_role;
CREATE TRIGGER free_worker_listing_guard BEFORE INSERT OR UPDATE ON public.api_listings
FOR EACH ROW EXECUTE FUNCTION public.free_worker_listing_guard();


-- Local additive adjustment. No backfill, provider permission edits, or automatic publication.
ALTER TABLE public.api_listings ADD COLUMN owner_rights_confirmation jsonb;
COMMENT ON COLUMN public.api_listings.owner_rights_confirmation IS
  'Authenticated owner declaration for paid API access; not provider permission or independent verification. Candidate evidence remains unchanged.';

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
REVOKE ALL ON FUNCTION public.free_worker_listing_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.free_worker_listing_guard() TO service_role;
