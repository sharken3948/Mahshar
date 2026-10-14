-- Explicit provenance for newly checkpointed Groq invitations only.
-- No backfill: historical, legacy and canary drafts retain unknown origin.
ALTER TABLE public.admin_acquisition_attempts
  ADD COLUMN draft_generator text,
  ADD COLUMN draft_prepared_at timestamptz,
  ADD CONSTRAINT admin_acquisition_draft_provenance_shape CHECK (
    (draft_generator IS NULL AND draft_prepared_at IS NULL)
    OR (draft_generator IS NOT NULL AND draft_generator='groq'
      AND draft_prepared_at IS NOT NULL AND subject IS NOT NULL AND body IS NOT NULL)
  );

-- Status/delivery updates and reservations of identical text preserve provenance.
-- Replacing the text cannot inherit another draft's generator or timestamp.
CREATE FUNCTION public.mahshar_acquisition_clear_changed_draft_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.draft_generator:=NULL;
    NEW.draft_prepared_at:=NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_clear_changed_draft_provenance() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER admin_acquisition_clear_changed_draft_provenance
  BEFORE UPDATE ON public.admin_acquisition_attempts
  FOR EACH ROW EXECUTE FUNCTION public.mahshar_acquisition_clear_changed_draft_provenance();

-- Keep the four-argument RPC intact. Old code saves unknown-origin drafts.
-- New code supplies this marker only after successful, validated Groq generation.
CREATE FUNCTION public.mahshar_acquisition_save_draft(
  p_attempt_id uuid,p_epoch uuid,p_subject text,p_body text,p_generator text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_generator IS DISTINCT FROM 'groq' THEN RETURN false; END IF;
  IF NOT public.mahshar_acquisition_save_draft(p_attempt_id,p_epoch,p_subject,p_body) THEN
    RETURN false;
  END IF;
  -- The existing RPC retains its locks through this transaction. Draft and
  -- provenance commit atomically; replay cannot relabel an existing draft.
  UPDATE public.admin_acquisition_attempts SET draft_generator='groq',draft_prepared_at=clock_timestamp()
    WHERE id=p_attempt_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.mahshar_acquisition_save_draft(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mahshar_acquisition_save_draft(uuid,uuid,text,text,text) TO service_role;

CREATE INDEX admin_acquisition_attempts_groq_prepared
  ON public.admin_acquisition_attempts(draft_prepared_at) WHERE draft_generator='groq';
