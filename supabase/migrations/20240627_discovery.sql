-- Discovery module migration

-- Add source and hourly_limit to api_listings
ALTER TABLE api_listings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS hourly_limit integer;

-- crawl_queue: candidate APIs from public-apis crawler
CREATE TABLE IF NOT EXISTS crawl_queue (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  description   text,
  category      text,
  endpoint_url  text        NOT NULL,
  auth          text,
  https         boolean,
  cors          text,
  status        text        NOT NULL DEFAULT 'pending',
  score         numeric(3,1),
  reject_reason text,
  listing_id    uuid        REFERENCES api_listings(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(endpoint_url)
);

-- discovered_apis: paid API owners found on GitHub
CREATE TABLE IF NOT EXISTS discovered_apis (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_url      text        NOT NULL UNIQUE,
  api_name      text,
  owner_github  text,
  owner_email   text,
  owner_x       text,
  invited       boolean     NOT NULL DEFAULT false,
  invited_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- outreach_log: record of every email sent
CREATE TABLE IF NOT EXISTS outreach_log (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_api_id  uuid        NOT NULL REFERENCES discovered_apis(id),
  email              text        NOT NULL,
  sent_at            timestamptz NOT NULL DEFAULT now(),
  status             text        NOT NULL DEFAULT 'sent'
);

CREATE INDEX IF NOT EXISTS idx_crawl_queue_status        ON crawl_queue(status);
CREATE INDEX IF NOT EXISTS idx_discovered_apis_invited   ON discovered_apis(invited);
CREATE INDEX IF NOT EXISTS idx_outreach_log_api_id       ON outreach_log(discovered_api_id);
