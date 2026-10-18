-- Source attribution expands additively. Existing cursors, revisions and candidate rows are retained.
ALTER TABLE public.worker_discovery_sources DROP CONSTRAINT worker_discovery_sources_source_id_check;
ALTER TABLE public.worker_discovery_sources ADD CONSTRAINT worker_discovery_sources_source_id_check CHECK(source_id IN ('apis_guru','public_api_lists','github_public_apis','public_apis_dev','apify_store','rapidapi','postman','zyla','apilayer','api_market','allthingsdev','apyhub','apis_io','api_tracker','api_directory'));
ALTER TABLE public.worker_candidates DROP CONSTRAINT worker_candidates_source_id_check;
ALTER TABLE public.worker_candidates ADD CONSTRAINT worker_candidates_source_id_check CHECK(source_id IS NULL OR source_id IN ('apis_guru','public_api_lists','github_public_apis','public_apis_dev','apify_store','rapidapi','postman','zyla','apilayer','api_market','allthingsdev','apyhub','apis_io','api_tracker','api_directory'));
INSERT INTO public.worker_discovery_sources(source_id) VALUES('github_public_apis'),('public_apis_dev'),('apify_store') ON CONFLICT DO NOTHING;

-- Reuse the existing run lock and budget ledger. Source caps cannot race or bypass the shared limit.
CREATE FUNCTION public.mahshar_worker_claim_discovery_request(p_run_id uuid,p_source_id text,p_attempt_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE target public.worker_runs; claim text;
BEGIN
 IF p_source_id NOT IN ('apis_guru','public_api_lists','github_public_apis','public_apis_dev','apify_store') OR p_source_id IS NULL OR p_attempt_id IS NULL
 THEN RAISE EXCEPTION 'worker_discovery_source_not_authorized'; END IF;
 SELECT * INTO target FROM public.worker_runs WHERE id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'worker_run_not_found'; END IF;
 IF target.status<>'running' OR target.deadline_at<=clock_timestamp() THEN RETURN 'deadline_reached'; END IF;
 claim:='http:'||p_source_id||':'||p_attempt_id::text;
 IF EXISTS(SELECT 1 FROM public.worker_budget_claims WHERE discovery_batch_id=target.discovery_batch_id AND budget_type='source' AND claim_key=claim)
 THEN RETURN 'replayed'; END IF;
 IF (SELECT count(*) FROM public.worker_budget_claims WHERE discovery_batch_id=target.discovery_batch_id AND budget_type='source'
   AND left(claim_key,length('http:'||p_source_id||':'))='http:'||p_source_id||':')>=40 THEN RETURN 'source_exhausted'; END IF;
 RETURN public.mahshar_worker_claim_budget_v2(p_run_id,'source',claim);
END $$;
REVOKE ALL ON FUNCTION public.mahshar_worker_claim_discovery_request(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_worker_claim_discovery_request(uuid,text,uuid) TO service_role;
