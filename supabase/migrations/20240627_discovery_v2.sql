-- Discovery module v2 migration

ALTER TABLE crawl_queue ADD COLUMN IF NOT EXISTS api_docs_url text;
ALTER TABLE crawl_queue ADD COLUMN IF NOT EXISTS source_name text;
ALTER TABLE api_listings ADD COLUMN IF NOT EXISTS latency_ms integer;
