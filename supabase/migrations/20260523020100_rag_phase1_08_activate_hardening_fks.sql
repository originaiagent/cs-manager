-- ============================================================================
-- RAG stage2 — rag_activate_generation ハードニング + FK (codex R3 [P0/P1/P2])
--   [P0] mutating fn を role_rag_search から剥奪 (search 役割で世代改変させない)。
--        indexer は service_role(owner) で実行。
--   [P0] p_job_id が当該 article/version のもので indexed chunk が在ることを検証。
--   [P1] 世代切替を article_version <> p_article_version で全旧世代を非active化
--        (古い rollback version を活性化しても単一 active 不変条件を保つ)。
--   [P2] FK: rag_chunk_access_stats.chunk_id → rag_chunks、
--        rag_article_active_generations.active_indexing_job_id → rag_indexing_jobs。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rag_activate_generation(p_article_id uuid, p_article_version int, p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_article_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.rag_indexing_jobs j WHERE j.id=p_job_id AND j.article_id=p_article_id AND j.article_version=p_article_version) THEN
    RAISE EXCEPTION 'rag_activate_generation: job % does not match article %/v%', p_job_id, p_article_id, p_article_version;
  END IF;
  -- codex R3 [P0]: indexed chunk が当該 p_job_id に紐づくことを検証 (別 job の chunk で通さない)
  IF NOT EXISTS (SELECT 1 FROM public.rag_chunks WHERE article_id=p_article_id AND article_version=p_article_version AND indexing_job_id=p_job_id AND status IN ('indexed','indexed_no_prefix')) THEN
    RAISE EXCEPTION 'rag_activate_generation: no indexed chunks for job % (article %/v%)', p_job_id, p_article_id, p_article_version;
  END IF;
  UPDATE public.rag_chunks SET is_active_generation=false, deprecated_at=now(), expires_at=now()+INTERVAL '365 days'
    WHERE article_id=p_article_id AND article_version<>p_article_version AND is_active_generation=true;
  UPDATE public.rag_chunks SET is_active_generation=true, activated_at=now()
    WHERE article_id=p_article_id AND article_version=p_article_version;
  INSERT INTO public.rag_article_active_generations (article_id, active_article_version, active_indexing_job_id, activated_at, previous_article_version, previous_deprecated_at)
    VALUES (p_article_id, p_article_version, p_job_id, now(), (SELECT active_article_version FROM public.rag_article_active_generations WHERE article_id=p_article_id), now())
  ON CONFLICT (article_id) DO UPDATE SET previous_article_version=public.rag_article_active_generations.active_article_version,
    previous_deprecated_at=now(), active_article_version=EXCLUDED.active_article_version, active_indexing_job_id=EXCLUDED.active_indexing_job_id, activated_at=now();
  UPDATE public.rag_indexing_jobs SET status='completed', completed_at=now() WHERE id=p_job_id;
END $fn$;

REVOKE ALL ON FUNCTION public.rag_activate_generation(uuid,int,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rag_activate_generation(uuid,int,uuid) FROM role_rag_search;

-- 自前新規テーブルへの FK 追加 (冪等: DROP CONSTRAINT を使わず IF NOT EXISTS ガード。
-- bc-check schema-diff の constraint-drop 誤検出を回避しつつ再適用安全)。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_ras_chunk') THEN
    ALTER TABLE public.rag_chunk_access_stats ADD CONSTRAINT fk_ras_chunk FOREIGN KEY (chunk_id) REFERENCES public.rag_chunks(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_aag_job') THEN
    ALTER TABLE public.rag_article_active_generations ADD CONSTRAINT fk_aag_job FOREIGN KEY (active_indexing_job_id) REFERENCES public.rag_indexing_jobs(id);
  END IF;
END $$;
