-- Fresh-database bootstrap for the original Mahshar marketplace schema.
-- Production predates the repository migration ledger; this migration must be
-- recorded as applied there only after its cumulative effects are verified.

CREATE TABLE public.api_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  price_per_call numeric(10, 6) NOT NULL,
  payment_model text NOT NULL
    CHECK (payment_model IN ('pay-per-call', 'credits', 'both')),
  seller_wallet text NOT NULL,
  auth_type text NOT NULL
    CHECK (auth_type IN ('public', 'apikey', 'bearer', 'queryparam')),
  encrypted_key text,
  auth_param_name text,
  endpoint_url text NOT NULL,
  example_request text,
  example_response text,
  score numeric(3, 1),
  uptime numeric(5, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT false
);

CREATE TABLE public.purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_wallet text NOT NULL,
  api_id uuid NOT NULL REFERENCES public.api_listings(id),
  amount_usdc numeric(10, 6) NOT NULL,
  tx_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.credit_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_wallet text NOT NULL UNIQUE,
  balance_usdc numeric(10, 6) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.api_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_id uuid NOT NULL REFERENCES public.api_listings(id),
  buyer_wallet text NOT NULL,
  payment_type text NOT NULL
    CHECK (payment_type IN ('pay-per-call', 'credits', 'both')),
  latency_ms integer NOT NULL,
  success boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_listings_category
  ON public.api_listings(category);
CREATE INDEX idx_api_listings_is_active
  ON public.api_listings(is_active);
CREATE INDEX idx_purchases_buyer_wallet
  ON public.purchases(buyer_wallet);
CREATE INDEX idx_purchases_api_id
  ON public.purchases(api_id);
CREATE INDEX idx_credit_balances_buyer_wallet
  ON public.credit_balances(buyer_wallet);
CREATE INDEX idx_api_calls_api_id
  ON public.api_calls(api_id);
CREATE INDEX idx_api_calls_buyer_wallet
  ON public.api_calls(buyer_wallet);

ALTER TABLE public.api_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_calls ENABLE ROW LEVEL SECURITY;

-- Listings contain private endpoint configuration and credentials. Public
-- catalog reads are mediated by server routes with explicit column allowlists.
REVOKE SELECT ON TABLE public.api_listings FROM anon, authenticated;
