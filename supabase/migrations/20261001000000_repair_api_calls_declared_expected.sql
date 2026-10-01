SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.api_calls
  ALTER COLUMN is_declared_expected SET DEFAULT false;

UPDATE public.api_calls
SET is_declared_expected = false
WHERE is_declared_expected IS NULL;

ALTER TABLE public.api_calls
  ALTER COLUMN is_declared_expected SET NOT NULL;
