-- Enable Row Level Security on discovery tables.
-- No policies are defined: the service role bypasses RLS, so the
-- server-side /api/discovery/scan and /api/discovery/outreach routes
-- continue to work. Anon and authenticated roles get zero access,
-- which is the intended posture — these tables contain PII (owner
-- emails, GitHub/X handles) and are never queried from the frontend.

ALTER TABLE public.discovered_apis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_log    ENABLE ROW LEVEL SECURITY;
