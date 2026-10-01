SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.api_listings
  ALTER COLUMN is_active SET DEFAULT false;
