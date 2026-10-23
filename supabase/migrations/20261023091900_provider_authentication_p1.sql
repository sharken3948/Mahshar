-- P1 only: existing encrypted_key representation and all other schema objects remain unchanged.
BEGIN;
ALTER TABLE public.api_listings DROP CONSTRAINT api_listings_auth_type_check;
ALTER TABLE public.api_listings ADD CONSTRAINT api_listings_auth_type_check CHECK (auth_type IN
  ('public', 'apikey', 'bearer', 'queryparam', 'basic', 'headers', 'authorization'));
COMMIT;
