-- Compact Brevo transactional delivery events for existing Outreach messages.
-- Delivery state is deliberately separate from the Outreach conversation state machine.

CREATE TABLE public.admin_outreach_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.admin_outreach_messages(id),
  provider_message_id text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 512),
  event_type text NOT NULL CHECK (event_type IN (
    'sent','delivered','opened','soft_bounce','hard_bounce','blocked'
  )),
  provider_event_id text NOT NULL CHECK (
    length(provider_event_id) BETWEEN 1 AND 64 AND provider_event_id ~ '^[0-9]+$'
  ),
  provider_occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (message_id,event_type)
);

CREATE INDEX admin_outreach_delivery_events_message_time
  ON public.admin_outreach_delivery_events(message_id,provider_occurred_at DESC,id);

-- The webhook RPC matches only by the normalized durable provider identifier
-- and exact recipient. Keep that lookup indexed without changing V1 records.
CREATE INDEX admin_outreach_messages_delivery_provider_match
  ON public.admin_outreach_messages(
    (lower(btrim(provider_message_id,'<> '))),recipient_email
  ) WHERE direction='outbound' AND status='sent' AND provider_message_id IS NOT NULL;

ALTER TABLE public.admin_outreach_delivery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.admin_outreach_delivery_events
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.admin_outreach_delivery_events TO service_role;

CREATE OR REPLACE FUNCTION public.mahshar_admin_outreach_ingest_delivery_event(
  p_provider_message_id text,
  p_recipient_email text,
  p_event_type text,
  p_provider_event_id text,
  p_provider_occurred_at timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  message_ids uuid[];
  target_message public.admin_outreach_messages;
  existing public.admin_outreach_delivery_events;
  stored public.admin_outreach_delivery_events;
  normalized_provider_id text;
BEGIN
  normalized_provider_id:=lower(btrim(p_provider_message_id,'<> '));
  IF p_provider_message_id IS NULL OR length(p_provider_message_id) NOT BETWEEN 1 AND 512
    OR p_provider_message_id ~ '[\r\n]' OR length(normalized_provider_id) NOT BETWEEN 1 AND 512
    OR p_recipient_email IS NULL OR p_recipient_email<>lower(p_recipient_email)
    OR p_recipient_email !~ '^[a-z0-9.!#$%&''*+=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
    OR p_event_type NOT IN ('sent','delivered','opened','soft_bounce','hard_bounce','blocked')
    OR p_provider_event_id IS NULL OR length(p_provider_event_id) NOT BETWEEN 1 AND 64
    OR p_provider_event_id !~ '^[0-9]+$' OR p_provider_occurred_at IS NULL
    OR p_provider_occurred_at<'2020-01-01T00:00:00Z'::timestamptz
    OR p_provider_occurred_at>clock_timestamp()+interval '1 day'
  THEN RAISE EXCEPTION 'admin_outreach_delivery_event_invalid'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(normalized_provider_id,80422));
  SELECT array_agg(message.id ORDER BY message.id) INTO message_ids
  FROM public.admin_outreach_messages message
  WHERE message.direction='outbound' AND message.status='sent'
    AND message.provider_message_id IS NOT NULL
    AND lower(btrim(message.provider_message_id,'<> '))=normalized_provider_id
    AND message.recipient_email=p_recipient_email;

  IF coalesce(cardinality(message_ids),0)<>1 THEN
    RETURN jsonb_build_object('matched',false,'duplicate',false,'messageId',NULL,'eventId',NULL);
  END IF;
  SELECT * INTO target_message FROM public.admin_outreach_messages WHERE id=message_ids[1] FOR UPDATE;
  SELECT * INTO existing FROM public.admin_outreach_delivery_events
    WHERE message_id=target_message.id AND event_type=p_event_type FOR UPDATE;
  IF FOUND AND existing.provider_occurred_at>=p_provider_occurred_at THEN
    RETURN jsonb_build_object('matched',true,'duplicate',true,'messageId',target_message.id,'eventId',existing.id);
  ELSIF FOUND THEN
    UPDATE public.admin_outreach_delivery_events SET
      provider_message_id=btrim(p_provider_message_id),provider_event_id=p_provider_event_id,
      provider_occurred_at=p_provider_occurred_at,received_at=clock_timestamp()
      WHERE id=existing.id RETURNING * INTO stored;
  ELSE
    INSERT INTO public.admin_outreach_delivery_events(
      message_id,provider_message_id,event_type,provider_event_id,provider_occurred_at
    ) VALUES (
      target_message.id,btrim(p_provider_message_id),p_event_type,p_provider_event_id,p_provider_occurred_at
    ) RETURNING * INTO stored;
  END IF;
  RETURN jsonb_build_object('matched',true,'duplicate',false,'messageId',target_message.id,'eventId',stored.id);
END $$;

REVOKE ALL ON FUNCTION public.mahshar_admin_outreach_ingest_delivery_event(text,text,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mahshar_admin_outreach_ingest_delivery_event(text,text,text,text,timestamptz)
  TO service_role;
