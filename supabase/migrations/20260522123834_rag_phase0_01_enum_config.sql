-- Phase 0 foundational: chunk_status ENUM + rag_config (DB-driven config, source of truth)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chunk_status') THEN
    CREATE TYPE public.chunk_status AS ENUM ('pending','indexed','indexed_no_prefix','failed','deprecated');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.rag_config (
  config_key TEXT PRIMARY KEY,
  config_value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);

INSERT INTO public.rag_config (config_key, config_value, description) VALUES
  ('default_embedding_model', '"openai-text-3-small"', '内部 alias の既定 embedding モデル'),
  ('embedding_model_external_map', '{"openai-text-3-small":"text-embedding-3-small"}', '内部alias→外部API実名 map'),
  ('default_embedding_modality', '"text"', '既定 modality'),
  ('default_embedding_version', '"2024-01-25"', '既定 embedding バージョン'),
  ('default_embedding_dimension', '1536', '既定 dimension'),
  ('default_k_rrf', '60', 'RRF k 定数'),
  ('default_chunk_size_cs_manager', '512', 'cs-manager chunk size (tokens)'),
  ('default_chunk_size_core', '800', 'core chunk size (tokens)'),
  ('default_chunk_overlap', '0', '既定 overlap'),
  ('default_match_count', '20', 'top-N 返却'),
  ('default_top_k_retrieval', '150', 'rerank 前 retrieval 数'),
  ('boost_exact_product', '0.08', 'product match additive boost'),
  ('boost_channel_match', '0.05', 'channel match additive boost'),
  ('boost_max', '0.15', 'soft boost 合計上限'),
  ('contextual_prefix_model', '"claude-haiku-4-5"', 'prefix 生成モデル'),
  ('reply_draft_model', '"claude-sonnet-4-6"', '返信ドラフト生成モデル'),
  ('worker_stuck_timeout_minutes', '5', 'indexing worker stuck 判定'),
  ('hnsw_ef_search', '100', 'HNSW ef_search'),
  -- feature flags (Phase 0: 安全側 default)
  ('rrf_search_enabled', 'true', 'RRF 検索 feature flag'),
  ('rerank_enabled', 'false', 'rerank feature flag (Phase 3 まで false)'),
  ('contextual_prefix_enabled', 'false', 'contextual prefix flag (A/B 前 false)'),
  ('tsvector_enabled', 'true', 'tsvector RRF 系統 flag'),
  ('trgm_enabled', 'true', 'trgm RRF 系統 flag'),
  ('rakuten_auto_send_enabled', 'false', '営業時間外 R-MessE 自動送信 (既定 false=dry-run、キー入手後トムが UI で on)')
ON CONFLICT (config_key) DO NOTHING;
