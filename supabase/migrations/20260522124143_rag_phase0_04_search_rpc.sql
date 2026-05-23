DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='role_rag_search') THEN
    CREATE ROLE role_rag_search NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.search_knowledge_rrf(
  query_embedding public.vector,
  query_text text,
  match_count int DEFAULT NULL,
  k_rrf int DEFAULT NULL,
  filter_visibility text[] DEFAULT ARRAY['public']::text[],
  filter_tenant_id uuid DEFAULT NULL,
  filter_channel_id uuid DEFAULT NULL,
  filter_user_id uuid DEFAULT NULL,
  filter_department_ids text[] DEFAULT NULL,
  filter_role_ids text[] DEFAULT NULL,
  relevance_boost jsonb DEFAULT '{}'::jsonb,
  embedding_model text DEFAULT NULL,
  embedding_modality text DEFAULT NULL,
  embedding_version_param text DEFAULT NULL
)
RETURNS TABLE(
  chunk_id uuid, article_id uuid, article_version int, content text, contextual_prefix text,
  metadata jsonb, rrf_score double precision,
  vector_rank int, tsvector_rank int, trgm_rank int
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_model text := COALESCE(embedding_model, (SELECT config_value #>> '{}' FROM public.rag_config WHERE config_key='default_embedding_model'));
  v_modality text := COALESCE(embedding_modality, (SELECT config_value #>> '{}' FROM public.rag_config WHERE config_key='default_embedding_modality'));
  v_k_rrf int := COALESCE(k_rrf, (SELECT (config_value #>> '{}')::int FROM public.rag_config WHERE config_key='default_k_rrf'));
  v_match_count int := COALESCE(match_count, (SELECT (config_value #>> '{}')::int FROM public.rag_config WHERE config_key='default_match_count'));
  v_top_k int := COALESCE((SELECT (config_value #>> '{}')::int FROM public.rag_config WHERE config_key='default_top_k_retrieval'), 150);
  v_boost_max double precision := COALESCE((SELECT (config_value #>> '{}')::double precision FROM public.rag_config WHERE config_key='boost_max'), 0.15);
  v_boost_product double precision := COALESCE((SELECT (config_value #>> '{}')::double precision FROM public.rag_config WHERE config_key='boost_exact_product'), 0.08);
  v_boost_channel double precision := COALESCE((SELECT (config_value #>> '{}')::double precision FROM public.rag_config WHERE config_key='boost_channel_match'), 0.05);
  v_ts_enabled boolean := COALESCE((SELECT (config_value #>> '{}')::boolean FROM public.rag_config WHERE config_key='tsvector_enabled'), true);
  v_trgm_enabled boolean := COALESCE((SELECT (config_value #>> '{}')::boolean FROM public.rag_config WHERE config_key='trgm_enabled'), true);
BEGIN
  RETURN QUERY
  WITH filtered_chunks AS (
    SELECT kc.id, kc.article_id, kc.article_version, kc.content, kc.contextual_prefix, kc.ts,
           kc.metadata, kc.product_id, kc.channel_id
    FROM public.rag_chunks kc
    JOIN public.rag_article_active_generations aa
      ON aa.article_id = kc.article_id AND aa.active_article_version = kc.article_version
    WHERE kc.is_active_generation = true
      AND kc.status IN ('indexed','indexed_no_prefix')
      AND (filter_tenant_id IS NULL OR kc.tenant_id = filter_tenant_id)
      AND (filter_channel_id IS NULL OR kc.channel_id = filter_channel_id)
      AND kc.visibility IN ('public','internal')
      AND kc.visibility = ANY(filter_visibility)
      AND (
        kc.visibility = 'public'
        OR (kc.visibility = 'internal' AND (
          (pg_catalog.jsonb_typeof(kc.allowed_departments)='array'
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(kc.allowed_departments) AS e(value) WHERE pg_catalog.jsonb_typeof(e.value)<>'string')
            AND filter_department_ids IS NOT NULL
            AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(kc.allowed_departments) d WHERE d = ANY(filter_department_ids)))
          OR (pg_catalog.jsonb_typeof(kc.allowed_roles)='array'
            AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(kc.allowed_roles) AS e(value) WHERE pg_catalog.jsonb_typeof(e.value)<>'string')
            AND filter_role_ids IS NOT NULL
            AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(kc.allowed_roles) r WHERE r = ANY(filter_role_ids)))
          OR (filter_user_id IS NOT NULL AND kc.allowed_user_ids IS NOT NULL AND filter_user_id = ANY(kc.allowed_user_ids))
        ))
      )
  ),
  vector_ranked AS (
    SELECT fc.id AS fid,
      ROW_NUMBER() OVER (ORDER BY ce.embedding OPERATOR(public.<=>) query_embedding) AS rank
    FROM filtered_chunks fc
    JOIN public.rag_chunk_embeddings ce
      ON ce.chunk_id = fc.id AND ce.model = v_model AND ce.modality = v_modality
      AND (embedding_version_param IS NULL OR ce.embedding_version = embedding_version_param)
    ORDER BY ce.embedding OPERATOR(public.<=>) query_embedding
    LIMIT v_top_k
  ),
  tsvector_ranked AS (
    SELECT fc.id AS fid,
      ROW_NUMBER() OVER (ORDER BY pg_catalog.ts_rank_cd(fc.ts, pg_catalog.plainto_tsquery('simple', query_text)) DESC) AS rank
    FROM filtered_chunks fc
    WHERE v_ts_enabled AND fc.ts @@ pg_catalog.plainto_tsquery('simple', query_text)
    LIMIT v_top_k
  ),
  trgm_ranked AS (
    SELECT fc.id AS fid,
      ROW_NUMBER() OVER (ORDER BY public.similarity(fc.content, query_text) DESC) AS rank
    FROM filtered_chunks fc
    WHERE v_trgm_enabled AND fc.content OPERATOR(public.%) query_text
    LIMIT v_top_k
  ),
  rrf AS (
    SELECT
      COALESCE(v.fid, t.fid, g.fid) AS fid,
      (COALESCE(1.0/(v_k_rrf + v.rank),0) + COALESCE(1.0/(v_k_rrf + t.rank),0) + COALESCE(1.0/(v_k_rrf + g.rank),0)) AS base_score,
      v.rank AS vrank, t.rank AS trank, g.rank AS grank
    FROM vector_ranked v
    FULL OUTER JOIN tsvector_ranked t ON t.fid = v.fid
    FULL OUTER JOIN trgm_ranked g ON g.fid = COALESCE(v.fid, t.fid)
  )
  SELECT
    rrf.fid, fc.article_id, fc.article_version, fc.content, fc.contextual_prefix, fc.metadata,
    (rrf.base_score + LEAST(v_boost_max,
       (CASE WHEN fc.product_id IS NOT NULL AND fc.product_id = (relevance_boost #>> '{product_id}') THEN v_boost_product ELSE 0 END)
     + (CASE WHEN fc.channel_id IS NOT NULL AND fc.channel_id::text = (relevance_boost #>> '{channel_id}') THEN v_boost_channel ELSE 0 END)
    ))::double precision AS rrf_score,
    rrf.vrank::int, rrf.trank::int, rrf.grank::int
  FROM rrf JOIN filtered_chunks fc ON fc.id = rrf.fid
  ORDER BY rrf_score DESC
  LIMIT v_match_count;
END
$fn$;

REVOKE ALL ON FUNCTION public.search_knowledge_rrf(public.vector, text, int, int, text[], uuid, uuid, uuid, text[], text[], jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_knowledge_rrf(public.vector, text, int, int, text[], uuid, uuid, uuid, text[], text[], jsonb, text, text, text) TO role_rag_search;
