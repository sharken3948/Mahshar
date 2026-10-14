-- Audit remediation: references are evidence only within the same recipient identity.
-- Existing rows remain unchanged. A one-time AI claim bounds duplicate inference.
ALTER TABLE public.admin_outreach_messages ADD COLUMN ai_claimed_at timestamptz;
CREATE INDEX admin_outreach_ai_claimed_day ON public.admin_outreach_messages(ai_claimed_at)
  WHERE ai_claimed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_ingest_inbound(
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
  candidates uuid[];
  matched_thread_id uuid;
  match_kind text;
  normalized_subject text;
  ambiguous_evidence boolean:=false;
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
    RETURN jsonb_build_object('id',existing.id,'threadId',existing.thread_id,'matchedBy',existing.matched_by,
      'processingState',existing.processing_state,'duplicate',true);
  END IF;

  IF p_in_reply_to IS NOT NULL THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND message.recipient_email=p_sender_email AND message.sender_email=p_recipient_email
      AND lower(btrim(message.provider_message_id,'<> '))=lower(btrim(p_in_reply_to,'<> '));
    IF cardinality(candidates)=1 THEN
      matched_thread_id:=candidates[1]; match_kind:='in_reply_to';
    ELSIF cardinality(candidates)>1 THEN ambiguous_evidence:=true;
    END IF;
  END IF;

  IF matched_thread_id IS NULL AND NOT ambiguous_evidence AND cardinality(p_reference_ids)>0 THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND message.recipient_email=p_sender_email AND message.sender_email=p_recipient_email
      AND EXISTS (SELECT 1 FROM unnest(p_reference_ids) reference_id
        WHERE lower(btrim(message.provider_message_id,'<> '))=lower(btrim(reference_id,'<> ')));
    IF cardinality(candidates)=1 THEN
      matched_thread_id:=candidates[1]; match_kind:='reference';
    ELSIF cardinality(candidates)>1 THEN ambiguous_evidence:=true;
    END IF;
  END IF;

  normalized_subject:=regexp_replace(lower(btrim(p_subject)),'^((re|fw|fwd)\s*:\s*)+','','i');
  IF matched_thread_id IS NULL AND NOT ambiguous_evidence THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND message.recipient_email=p_sender_email AND message.sender_email=p_recipient_email
      AND regexp_replace(lower(btrim(message.subject)),'^((re|fw|fwd)\s*:\s*)+','','i')=normalized_subject;
    IF cardinality(candidates)=1 THEN
      matched_thread_id:=candidates[1]; match_kind:='subject_context';
    ELSIF cardinality(candidates)>1 THEN ambiguous_evidence:=true;
    END IF;
  END IF;

  IF matched_thread_id IS NULL AND NOT ambiguous_evidence THEN
    SELECT array_agg(DISTINCT message.thread_id) INTO candidates
    FROM public.admin_outreach_messages message
    WHERE message.direction='outbound' AND message.status='sent' AND message.thread_id IS NOT NULL
      AND message.recipient_email=p_sender_email AND message.sender_email=p_recipient_email;
    IF cardinality(candidates)=1 THEN matched_thread_id:=candidates[1]; match_kind:='sender_unambiguous'; END IF;
  END IF;

  INSERT INTO public.admin_outreach_messages(thread_id,direction,status,recipient_email,sender_email,
    subject,body,provider_message_id,in_reply_to,reference_ids,received_at,processing_state,matched_by)
  VALUES(matched_thread_id,'inbound','received',p_recipient_email,p_sender_email,btrim(p_subject),btrim(p_body),
    p_provider_message_id,p_in_reply_to,coalesce(p_reference_ids,'{}'::text[]),p_received_at,
    CASE WHEN matched_thread_id IS NULL THEN 'unmatched' ELSE 'received' END,match_kind)
  RETURNING * INTO inbound;

  IF matched_thread_id IS NOT NULL THEN
    UPDATE public.admin_outreach_threads SET last_reply_at=p_received_at,updated_at=clock_timestamp()
      WHERE id=matched_thread_id;
  END IF;
  RETURN jsonb_build_object('id',inbound.id,'threadId',inbound.thread_id,'matchedBy',inbound.matched_by,
    'processingState',inbound.processing_state,'duplicate',false);
END $$;

CREATE FUNCTION public.mahshar_admin_outreach_claim_inbound_ai(p_message_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE message public.admin_outreach_messages;
  utc_day timestamptz:=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  PERFORM pg_advisory_xact_lock(80422);
  SELECT * INTO message FROM public.admin_outreach_messages WHERE id=p_message_id FOR UPDATE;
  IF NOT FOUND OR message.direction<>'inbound' OR message.thread_id IS NULL
    OR message.processing_state NOT IN ('received','suggestion_failed') OR message.ai_claimed_at IS NOT NULL
    THEN RETURN false; END IF;
  -- At most 25 reply investigations / 50 model calls per UTC day, including retries.
  IF (SELECT count(*) FROM public.admin_outreach_messages
    WHERE ai_claimed_at>=utc_day AND ai_claimed_at<utc_day+interval '1 day')>=25 THEN RETURN false; END IF;
  UPDATE public.admin_outreach_messages SET ai_claimed_at=clock_timestamp() WHERE id=p_message_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_ingest_inbound(text,text,text[],text,text,text,text,timestamptz),
  public.mahshar_admin_outreach_claim_inbound_ai(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_ingest_inbound(text,text,text[],text,text,text,text,timestamptz),
  public.mahshar_admin_outreach_claim_inbound_ai(uuid) TO service_role;
