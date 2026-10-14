-- No trusted MIME-From authentication/alignment verdict is established by the
-- current Cloudflare bridge. Fail closed; do not manufacture a verified identity.
-- Preserve existing messages, classifications, threads and delivery history.
ALTER TABLE public.admin_outreach_messages
  ADD COLUMN sender_identity_status text NOT NULL DEFAULT 'unverified'
    CHECK (sender_identity_status='unverified');

-- The existing eight-argument contract remains accepted for old bridge/app code.
-- Both new events and replays of historical matched events project as unmatched.
CREATE FUNCTION public.mahshar_admin_outreach_ingest_unverified_inbound(
  p_provider_message_id text,
  p_in_reply_to text,
  p_reference_ids text[],
  p_sender_email text,
  p_recipient_email text,
  p_subject text,
  p_body text,
  p_received_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  existing public.admin_outreach_messages;
  inbound public.admin_outreach_messages;
BEGIN
  IF p_provider_message_id IS NULL OR length(p_provider_message_id) NOT BETWEEN 1 AND 512
    OR p_provider_message_id ~ '[\r\n]'
    OR p_in_reply_to IS NOT NULL AND (length(p_in_reply_to) NOT BETWEEN 1 AND 512 OR p_in_reply_to ~ '[\r\n]')
    OR coalesce(cardinality(p_reference_ids),0) > 12
    OR EXISTS (SELECT 1 FROM unnest(coalesce(p_reference_ids,'{}'::text[])) value
      WHERE length(value) NOT BETWEEN 1 AND 512 OR value ~ '[\r\n]')
    OR p_sender_email IS NULL OR p_sender_email<>lower(p_sender_email)
    OR p_sender_email !~ '^[a-z0-9.!#$%&''*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
    OR p_recipient_email IS NULL OR p_recipient_email<>'support@mahshar.xyz'
    OR coalesce(length(btrim(p_subject)),0) NOT BETWEEN 1 AND 200
    OR coalesce(length(btrim(p_body)),0) NOT BETWEEN 1 AND 5000
    OR p_received_at IS NULL
  THEN RAISE EXCEPTION 'admin_outreach_inbound_invalid'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_provider_message_id,80421));
  SELECT * INTO existing FROM public.admin_outreach_messages
    WHERE direction='inbound' AND provider_message_id=p_provider_message_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('id',existing.id,'threadId',NULL,'matchedBy',NULL,
      'processingState','unmatched','duplicate',true,'senderIdentityVerified',false);
  END IF;

  INSERT INTO public.admin_outreach_messages(thread_id,direction,status,recipient_email,sender_email,
    subject,body,provider_message_id,in_reply_to,reference_ids,received_at,processing_state,matched_by)
  VALUES(NULL,'inbound','received',p_recipient_email,p_sender_email,btrim(p_subject),btrim(p_body),
    p_provider_message_id,p_in_reply_to,coalesce(p_reference_ids,'{}'::text[]),p_received_at,
    'unmatched',NULL)
  RETURNING * INTO inbound;

  RETURN jsonb_build_object('id',inbound.id,'threadId',inbound.thread_id,'matchedBy',inbound.matched_by,
    'processingState',inbound.processing_state,'duplicate',false,'senderIdentityVerified',false);
END $$;


-- A new application cannot accidentally call the old matching implementation
-- if deployed before this migration; the new ingest RPC fails closed if absent.
CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_ingest_inbound(
  p_provider_message_id text,p_in_reply_to text,p_reference_ids text[],p_sender_email text,
  p_recipient_email text,p_subject text,p_body text,p_received_at timestamptz
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT public.mahshar_admin_outreach_ingest_unverified_inbound(p_provider_message_id,p_in_reply_to,
    p_reference_ids,p_sender_email,p_recipient_email,p_subject,p_body,p_received_at)
$$;

-- Disable all identity-sensitive automated actions, including callers of the
-- original RPCs. Restoring authenticated matching requires a separately reviewed
-- receiver evidence contract; no payload boolean or MIME header can enable it.
CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_finalize_inbound(
  p_message_id uuid,p_classification text,p_confidence numeric,p_reason text,
  p_processing_state text,p_suggested_subject text,p_suggested_body text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'admin_outreach_sender_identity_unverified'; END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_claim_inbound_ai(p_message_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RETURN false; END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_approve_reply_draft(p_message_id uuid,p_admin_wallet text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'admin_outreach_sender_identity_unverified'; END $$;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_assert_reply_sendable(p_message_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'admin_outreach_sender_identity_unverified'; END $$;

REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_ingest_unverified_inbound(text,text,text[],text,text,text,text,timestamptz),
  public.mahshar_admin_outreach_ingest_inbound(text,text,text[],text,text,text,text,timestamptz),
  public.mahshar_admin_outreach_finalize_inbound(uuid,text,numeric,text,text,text,text),
  public.mahshar_admin_outreach_claim_inbound_ai(uuid),public.mahshar_admin_outreach_approve_reply_draft(uuid,text),
  public.mahshar_admin_outreach_assert_reply_sendable(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_ingest_unverified_inbound(text,text,text[],text,text,text,text,timestamptz),
  public.mahshar_admin_outreach_ingest_inbound(text,text,text[],text,text,text,text,timestamptz),
  public.mahshar_admin_outreach_finalize_inbound(uuid,text,numeric,text,text,text,text),
  public.mahshar_admin_outreach_claim_inbound_ai(uuid),public.mahshar_admin_outreach_approve_reply_draft(uuid,text),
  public.mahshar_admin_outreach_assert_reply_sendable(uuid) TO service_role;
