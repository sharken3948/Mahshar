-- api_listings: registered APIs available for purchase
create table if not exists api_listings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null,
  category text not null,
  price_per_call numeric(10, 6) not null,
  payment_model text not null check (payment_model in ('pay-per-call', 'credits', 'both')),
  seller_wallet text not null,
  auth_type text not null check (auth_type in ('public', 'apikey', 'bearer', 'queryparam', 'basic', 'headers', 'authorization', 'oauth_client_credentials', 'oauth_pkce')),
  encrypted_key text,
  verified_at timestamptz,
  auth_param_name text,
  endpoint_url text not null,
  example_request text,
  example_response text,
  request_schema jsonb,
  response_schema jsonb,
  body_required boolean,
  dynamic_path_supported boolean not null default false,
  path_parameters jsonb,
  query_parameters jsonb,
  score numeric(3, 1),
  uptime numeric(5, 2),
  created_at timestamptz not null default now(),
  is_active boolean not null default false
);

-- purchases: completed payment records
create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  buyer_wallet text not null,
  api_id uuid not null references api_listings(id),
  amount_usdc numeric(10, 6) not null,
  tx_hash text not null,
  created_at timestamptz not null default now()
);

-- credit_balances: prepaid USDC credit per buyer wallet
create table if not exists credit_balances (
  id uuid primary key default gen_random_uuid(),
  buyer_wallet text not null unique,
  balance_usdc numeric(10, 6) not null default 0,
  updated_at timestamptz not null default now()
);

-- api_calls: usage log for every proxied request
create table if not exists api_calls (
  id uuid primary key default gen_random_uuid(),
  api_id uuid not null references api_listings(id),
  buyer_wallet text not null,
  payment_type text not null check (payment_type in ('pay-per-call', 'credits', 'both')),
  latency_ms integer not null,
  success boolean not null,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_api_listings_category on api_listings(category);
create index if not exists idx_api_listings_is_active on api_listings(is_active);
create index if not exists idx_purchases_buyer_wallet on purchases(buyer_wallet);
create index if not exists idx_purchases_api_id on purchases(api_id);
create index if not exists idx_credit_balances_buyer_wallet on credit_balances(buyer_wallet);
create index if not exists idx_api_calls_api_id on api_calls(api_id);
create index if not exists idx_api_calls_buyer_wallet on api_calls(buyer_wallet);

-- Row-level security
alter table api_listings enable row level security;
alter table purchases enable row level security;
alter table credit_balances enable row level security;
alter table api_calls enable row level security;

-- Listing rows contain endpoint_url and encrypted_key. Public catalog reads go
-- through server routes with explicit column allowlists; anon/authenticated
-- roles intentionally have no direct api_listings SELECT policy.
revoke select on api_listings from anon, authenticated;

-- Service role bypasses RLS for server-side operations

-- Provider OAuth schema (also installed by the forward migration).
CREATE TABLE public.provider_oauth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id uuid NOT NULL REFERENCES public.api_listings(id) ON DELETE CASCADE,
  owner_wallet text NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
  account_mode text NOT NULL CHECK (account_mode IN ('seller', 'buyer')),
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  encrypted_tokens text,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'reauthorization_required')),
  revision bigint NOT NULL DEFAULT 0,
  lease_id uuid,
  lease_until timestamptz,
  UNIQUE(api_id, owner_wallet, account_mode, config_hash)
);
CREATE TABLE public.provider_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  api_id uuid NOT NULL REFERENCES public.api_listings(id) ON DELETE CASCADE,
  owner_wallet text NOT NULL CHECK (owner_wallet ~ '^0x[0-9a-f]{40}$'),
  account_mode text NOT NULL CHECK (account_mode IN ('seller', 'buyer')),
  config_hash text NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  session_hash text NOT NULL,
  browser_hash text NOT NULL,
  encrypted_verifier text NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at <= now() + interval '10 minutes'),
  used_at timestamptz
);
CREATE INDEX provider_oauth_states_expiry ON public.provider_oauth_states(expires_at);
CREATE INDEX provider_oauth_states_account ON public.provider_oauth_states(api_id, owner_wallet, account_mode);
ALTER TABLE public.provider_oauth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_oauth_accounts, public.provider_oauth_states FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_oauth_accounts, public.provider_oauth_states TO service_role;

CREATE FUNCTION public.mahshar_oauth_invalidate_configuration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.provider_oauth_states WHERE api_id=NEW.id;
  UPDATE public.provider_oauth_accounts SET encrypted_tokens=NULL,expires_at=NULL,status='disconnected',
    lease_id=NULL,lease_until=NULL,revision=revision+1 WHERE api_id=NEW.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_oauth_invalidate_configuration() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER provider_oauth_configuration_changed AFTER UPDATE OF encrypted_key,auth_type,endpoint_url,seller_wallet
ON public.api_listings FOR EACH ROW WHEN (OLD.encrypted_key IS DISTINCT FROM NEW.encrypted_key OR
  OLD.auth_type IS DISTINCT FROM NEW.auth_type OR OLD.endpoint_url IS DISTINCT FROM NEW.endpoint_url OR
  OLD.seller_wallet IS DISTINCT FROM NEW.seller_wallet)
EXECUTE FUNCTION public.mahshar_oauth_invalidate_configuration();

-- All token replacement is fenced by a DB lease. A timed-out refresh is never
-- retried with a potentially consumed rotating refresh token.
CREATE FUNCTION public.mahshar_oauth_claim(p_api_id uuid, p_wallet text, p_mode text,
  p_config_hash text, p_ciphertext text, p_create boolean, p_lease uuid)
RETURNS SETOF public.provider_oauth_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE a public.provider_oauth_accounts; l public.api_listings;
BEGIN
  SELECT * INTO l FROM public.api_listings WHERE id=p_api_id FOR SHARE;
  IF NOT FOUND OR l.encrypted_key IS DISTINCT FROM p_ciphertext OR
    (p_mode='seller' AND lower(l.seller_wallet)<>p_wallet) OR
    l.auth_type NOT IN ('oauth_client_credentials','oauth_pkce') OR
    (p_create AND (l.auth_type<>'oauth_client_credentials' OR p_mode<>'seller')) THEN
    RAISE EXCEPTION 'oauth configuration changed';
  END IF;
  IF p_create THEN
    INSERT INTO public.provider_oauth_accounts(api_id,owner_wallet,account_mode,config_hash)
    VALUES(p_api_id,p_wallet,p_mode,p_config_hash) ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO a FROM public.provider_oauth_accounts WHERE api_id=p_api_id AND
    owner_wallet=p_wallet AND account_mode=p_mode AND config_hash=p_config_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF a.status<>'active' THEN RETURN NEXT a; RETURN; END IF;
  IF a.encrypted_tokens IS NOT NULL AND a.expires_at>now()+interval '60 seconds' THEN RETURN NEXT a; RETURN; END IF;
  IF a.lease_id IS NOT NULL THEN
    IF a.lease_until<=now() THEN
      UPDATE public.provider_oauth_accounts SET status='reauthorization_required',encrypted_tokens=NULL,
        expires_at=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1 WHERE id=a.id RETURNING * INTO a;
    END IF;
    RETURN NEXT a; RETURN;
  END IF;
  UPDATE public.provider_oauth_accounts SET lease_id=p_lease,lease_until=now()+interval '30 seconds',
    revision=revision+1 WHERE id=a.id RETURNING * INTO a;
  RETURN NEXT a;
END $$;

CREATE FUNCTION public.mahshar_oauth_finish(p_id uuid, p_lease uuid, p_revision bigint,
  p_ciphertext text, p_tokens text, p_expires timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed integer;
BEGIN
  PERFORM 1 FROM public.api_listings l JOIN public.provider_oauth_accounts a ON a.api_id=l.id
    WHERE a.id=p_id AND l.encrypted_key=p_ciphertext FOR SHARE OF l;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.provider_oauth_accounts SET encrypted_tokens=p_tokens,expires_at=p_expires,
    status=CASE WHEN p_tokens IS NULL THEN 'reauthorization_required' ELSE 'active' END,
    lease_id=NULL,lease_until=NULL,revision=revision+1
  WHERE id=p_id AND lease_id=p_lease AND revision=p_revision AND status='active' AND lease_until>now();
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;

-- Disconnect and callback completion serialize through the listing row. Deleting
-- pending states cancels consent exchanges already in flight.
CREATE FUNCTION public.mahshar_oauth_complete(p_state text, p_ciphertext text, p_tokens text, p_expires timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s public.provider_oauth_states;
BEGIN
  SELECT * INTO s FROM public.provider_oauth_states WHERE state_hash=p_state;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.api_listings WHERE id=s.api_id AND encrypted_key=p_ciphertext AND
    auth_type='oauth_pkce' AND (s.account_mode='buyer' OR lower(seller_wallet)=s.owner_wallet) FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM public.provider_oauth_states WHERE state_hash=p_state AND used_at IS NOT NULL AND expires_at>now() RETURNING * INTO s;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.provider_oauth_accounts(api_id,owner_wallet,account_mode,config_hash,encrypted_tokens,expires_at)
    VALUES(s.api_id,s.owner_wallet,s.account_mode,s.config_hash,p_tokens,p_expires)
  ON CONFLICT(api_id,owner_wallet,account_mode,config_hash) DO UPDATE SET
    encrypted_tokens=EXCLUDED.encrypted_tokens,expires_at=EXCLUDED.expires_at,status='active',
    revision=provider_oauth_accounts.revision+1,lease_id=NULL,lease_until=NULL;
  IF s.account_mode='seller' THEN
    UPDATE public.api_listings SET is_active=false,verified_at=NULL WHERE id=s.api_id;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.mahshar_oauth_disconnect(p_api_id uuid, p_wallet text, p_mode text)
RETURNS SETOF public.provider_oauth_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.api_listings WHERE id=p_api_id AND (p_mode='buyer' OR lower(seller_wallet)=p_wallet) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'oauth owner mismatch'; END IF;
  DELETE FROM public.provider_oauth_states WHERE api_id=p_api_id AND owner_wallet=p_wallet AND account_mode=p_mode;
  RETURN QUERY SELECT * FROM public.provider_oauth_accounts WHERE api_id=p_api_id AND owner_wallet=p_wallet AND account_mode=p_mode FOR UPDATE;
  UPDATE public.provider_oauth_accounts SET status='disconnected',encrypted_tokens=NULL,expires_at=NULL,
    lease_id=NULL,lease_until=NULL,revision=revision+1 WHERE api_id=p_api_id AND owner_wallet=p_wallet AND account_mode=p_mode;
  -- Seller disconnect also prevents accepting new paid requests for this listing.
  IF p_mode='seller' THEN UPDATE public.api_listings SET is_active=false,verified_at=NULL WHERE id=p_api_id; END IF;
END $$;

REVOKE ALL ON FUNCTION public.mahshar_oauth_claim(uuid,text,text,text,text,boolean,uuid),
  public.mahshar_oauth_finish(uuid,uuid,bigint,text,text,timestamptz),
  public.mahshar_oauth_complete(text,text,text,timestamptz),
  public.mahshar_oauth_disconnect(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_oauth_claim(uuid,text,text,text,text,boolean,uuid),
  public.mahshar_oauth_finish(uuid,uuid,bigint,text,text,timestamptz),
  public.mahshar_oauth_complete(text,text,text,timestamptz),
  public.mahshar_oauth_disconnect(uuid,text,text) TO service_role;
