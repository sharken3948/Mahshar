-- api_listings: registered APIs available for purchase
create table if not exists api_listings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null,
  category text not null,
  price_per_call numeric(10, 6) not null,
  payment_model text not null check (payment_model in ('pay-per-call', 'credits', 'both')),
  seller_wallet text not null,
  auth_type text not null check (auth_type in ('public', 'apikey', 'bearer')),
  encrypted_key text,
  endpoint_url text not null,
  example_request text,
  example_response text,
  score numeric(3, 1),
  uptime numeric(5, 2),
  created_at timestamptz not null default now(),
  is_active boolean not null default true
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

-- Public read access for active listings
create policy "public read active listings"
  on api_listings for select
  using (is_active = true);

-- Service role bypasses RLS for server-side operations
