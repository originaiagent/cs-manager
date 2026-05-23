CREATE OR REPLACE FUNCTION public.rag_activate_generation(
  p_article_id uuid, p_article_version int, p_job_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_article_id::text));

  UPDATE public.rag_chunks
    SET is_active_generation = false, deprecated_at = now(), expires_at = now() + INTERVAL '365 days'
    WHERE article_id = p_article_id AND article_version < p_article_version AND is_active_generation = true;

  UPDATE public.rag_chunks
    SET is_active_generation = true, activated_at = now()
    WHERE article_id = p_article_id AND article_version = p_article_version;

  INSERT INTO public.rag_article_active_generations
    (article_id, active_article_version, active_indexing_job_id, activated_at, previous_article_version, previous_deprecated_at)
  VALUES (p_article_id, p_article_version, p_job_id, now(),
          (SELECT active_article_version FROM public.rag_article_active_generations WHERE article_id = p_article_id), now())
  ON CONFLICT (article_id) DO UPDATE SET
    previous_article_version = public.rag_article_active_generations.active_article_version,
    previous_deprecated_at = now(),
    active_article_version = EXCLUDED.active_article_version,
    active_indexing_job_id = EXCLUDED.active_indexing_job_id,
    activated_at = now();

  UPDATE public.rag_indexing_jobs SET status = 'completed', completed_at = now() WHERE id = p_job_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.rag_activate_generation(uuid, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rag_activate_generation(uuid, int, uuid) TO role_rag_search;
