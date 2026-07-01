-- Track C (Bug2b 根治): search_knowledge_rrf の日本語検索縮退是正 (cs 版)
-- 日本語で tsvector('simple')/trgm(%) アームが 0hit のため単アーム(vector)RRF=1/(60+rank)≈0.016 均一だった。
-- vector アームの cos_sim を score に合成し「意味のある分布」に是正 (codex 設計APPROVE / A案)。
--   - v_vec_weight: config 'vector_score_weight' 駆動(既定 1.0)。
--   - relevance floor: config 'vector_max_cos_distance' 駆動、未設定なら無効(後方互換=recall不変)。
--   - cos_sim = GREATEST(0, 1 - cos_dist) で clamp(pgvector cosine distance の負域対策)。
-- 戻り列・ACL・boost・SECURITY DEFINER/search_path は不変。cs は internal を ACL 無しで許可(従来どおり)。
CREATE OR REPLACE FUNCTION public.search_knowledge_rrf(query_embedding vector, query_text text, match_count integer DEFAULT NULL::integer, k_rrf integer DEFAULT NULL::integer, filter_visibility text[] DEFAULT ARRAY['public'::text], filter_tenant_id uuid DEFAULT NULL::uuid, filter_channel_id uuid DEFAULT NULL::uuid, filter_user_id uuid DEFAULT NULL::uuid, filter_department_ids text[] DEFAULT NULL::text[], filter_role_ids text[] DEFAULT NULL::text[], relevance_boost jsonb DEFAULT '{}'::jsonb, embedding_model text DEFAULT NULL::text, embedding_modality text DEFAULT NULL::text, embedding_version_param text DEFAULT NULL::text)
 RETURNS TABLE(chunk_id uuid, article_id uuid, article_version integer, content text, contextual_prefix text, metadata jsonb, rrf_score double precision, vector_rank integer, tsvector_rank integer, trgm_rank integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_rrf_enabled boolean := COALESCE((SELECT (config_value #>> '{}')::boolean FROM public.rag_config WHERE config_key='rrf_search_enabled'), true);
  v_vec_weight double precision := COALESCE((SELECT (config_value #>> '{}')::double precision FROM public.rag_config WHERE config_key='vector_score_weight'), 1.0);
  v_max_cos_dist double precision := (SELECT (config_value #>> '{}')::double precision FROM public.rag_config WHERE config_key='vector_max_cos_distance');
BEGIN
  IF NOT v_rrf_enabled THEN RETURN; END IF;
  RETURN QUERY
  WITH filtered_chunks AS (
    SELECT kc.id, kc.article_id, kc.article_version, kc.content, kc.contextual_prefix, kc.ts, kc.metadata, kc.product_id, kc.channel_id
    FROM public.rag_chunks kc
    JOIN public.rag_article_active_generations aa ON aa.article_id = kc.article_id AND aa.active_article_version = kc.article_version
    WHERE kc.is_active_generation = true AND kc.status IN ('indexed','indexed_no_prefix')
      AND (filter_tenant_id IS NULL OR kc.tenant_id = filter_tenant_id)
      AND (filter_channel_id IS NULL OR kc.channel_id = filter_channel_id)
      AND kc.visibility IN ('public','internal') AND kc.visibility = ANY(filter_visibility)
      -- cs: public/internal とも filter_visibility で選択。internal は社内ツール内アクセス可(ACL gating 無し)。
  ),
  vector_ranked AS (
    SELECT fc.id AS fid,
      ROW_NUMBER() OVER (ORDER BY ce.embedding OPERATOR(public.<=>) query_embedding) AS rank,
      (ce.embedding OPERATOR(public.<=>) query_embedding) AS cos_dist
    FROM filtered_chunks fc JOIN public.rag_chunk_embeddings ce ON ce.chunk_id = fc.id AND ce.model = v_model AND ce.modality = v_modality
      AND (embedding_version_param IS NULL OR ce.embedding_version = embedding_version_param)
    WHERE (v_max_cos_dist IS NULL OR (ce.embedding OPERATOR(public.<=>) query_embedding) <= v_max_cos_dist)
    ORDER BY ce.embedding OPERATOR(public.<=>) query_embedding LIMIT v_top_k
  ),
  tsvector_ranked AS (
    SELECT fc.id AS fid, ROW_NUMBER() OVER (ORDER BY pg_catalog.ts_rank_cd(fc.ts, pg_catalog.plainto_tsquery('simple', query_text)) DESC) AS rank
    FROM filtered_chunks fc WHERE v_ts_enabled AND fc.ts @@ pg_catalog.plainto_tsquery('simple', query_text) LIMIT v_top_k
  ),
  trgm_ranked AS (
    SELECT fc.id AS fid, ROW_NUMBER() OVER (ORDER BY public.similarity(fc.content, query_text) DESC) AS rank
    FROM filtered_chunks fc WHERE v_trgm_enabled AND fc.content OPERATOR(public.%) query_text LIMIT v_top_k
  ),
  rrf AS (
    SELECT COALESCE(v.fid, t.fid, g.fid) AS fid,
      (COALESCE(1.0/(v_k_rrf + v.rank),0) + COALESCE(1.0/(v_k_rrf + t.rank),0) + COALESCE(1.0/(v_k_rrf + g.rank),0)
       + COALESCE(v_vec_weight * GREATEST(0::double precision, 1 - v.cos_dist), 0)) AS base_score,
      v.rank AS vrank, t.rank AS trank, g.rank AS grank
    FROM vector_ranked v FULL OUTER JOIN tsvector_ranked t ON t.fid = v.fid FULL OUTER JOIN trgm_ranked g ON g.fid = COALESCE(v.fid, t.fid)
  )
  SELECT rrf.fid, fc.article_id, fc.article_version, fc.content, fc.contextual_prefix, fc.metadata,
    (rrf.base_score + LEAST(v_boost_max,
       (CASE WHEN fc.product_id IS NOT NULL AND fc.product_id = (relevance_boost #>> '{product_id}') THEN v_boost_product ELSE 0 END)
     + (CASE WHEN fc.channel_id IS NOT NULL AND fc.channel_id::text = (relevance_boost #>> '{channel_id}') THEN v_boost_channel ELSE 0 END)))::double precision AS rrf_score,
    rrf.vrank::int, rrf.trank::int, rrf.grank::int
  FROM rrf JOIN filtered_chunks fc ON fc.id = rrf.fid ORDER BY rrf_score DESC LIMIT v_match_count;
END $function$;
