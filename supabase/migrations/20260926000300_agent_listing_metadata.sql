-- Optional, backward-compatible machine contract metadata. NULL means the
-- seller has not supplied a contract; legacy listings remain executable.
ALTER TABLE public.api_listings
  ADD COLUMN IF NOT EXISTS request_schema jsonb,
  ADD COLUMN IF NOT EXISTS response_schema jsonb,
  ADD COLUMN IF NOT EXISTS body_required boolean,
  ADD COLUMN IF NOT EXISTS dynamic_path_supported boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS path_parameters jsonb,
  ADD COLUMN IF NOT EXISTS query_parameters jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_listings_request_schema_object'
      AND conrelid = 'public.api_listings'::regclass
  ) THEN
    ALTER TABLE public.api_listings
      ADD CONSTRAINT api_listings_request_schema_object
      CHECK (request_schema IS NULL OR jsonb_typeof(request_schema)='object');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_listings_response_schema_object'
      AND conrelid = 'public.api_listings'::regclass
  ) THEN
    ALTER TABLE public.api_listings
      ADD CONSTRAINT api_listings_response_schema_object
      CHECK (response_schema IS NULL OR jsonb_typeof(response_schema)='object');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_listings_path_parameters_array'
      AND conrelid = 'public.api_listings'::regclass
  ) THEN
    ALTER TABLE public.api_listings
      ADD CONSTRAINT api_listings_path_parameters_array
      CHECK (path_parameters IS NULL OR jsonb_typeof(path_parameters)='array');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_listings_query_parameters_array'
      AND conrelid = 'public.api_listings'::regclass
  ) THEN
    ALTER TABLE public.api_listings
      ADD CONSTRAINT api_listings_query_parameters_array
      CHECK (query_parameters IS NULL OR jsonb_typeof(query_parameters)='array');
  END IF;
END $$;
