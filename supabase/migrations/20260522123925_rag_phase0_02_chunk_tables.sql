-- Phase 0/1: RAG chunk store (案C 命名, 非partition Phase1-4)
CREATE TABLE IF NOT EXISTS public.rag_indexing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES public.knowledge_articles(id) ON DELETE CASCADE,
  article_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  chunking_version TEXT NOT NULL,
  embedding_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  generation_number INTEGER NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  worker_id TEXT,
  worker_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_id, content_hash, chunking_version, embedding_version)
);

CREATE TABLE IF NOT EXISTS public.rag_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES public.knowledge_articles(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  contextual_prefix TEXT,
  token_count INTEGER,
  article_version INTEGER NOT NULL,
  is_active_generation BOOLEAN NOT NULL DEFAULT false,
  indexing_job_id UUID REFERENCES public.rag_indexing_jobs(id),
  activated_at TIMESTAMPTZ,
  deprecated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  chunking_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  prefix_model TEXT,
  prefix_prompt_version TEXT,
  source_updated_at TIMESTAMPTZ NOT NULL,
  status public.chunk_status NOT NULL DEFAULT 'pending',
  error TEXT,
  tenant_id UUID,
  channel_id UUID,
  product_id TEXT,
  store_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'internal',
  allowed_departments JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  allowed_user_ids UUID[],
  ts TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(contextual_prefix,'') || ' ' || content)
  ) STORED,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (article_id, article_version, chunk_index)
);

CREATE TABLE IF NOT EXISTS public.rag_chunk_embeddings (
  chunk_id UUID NOT NULL REFERENCES public.rag_chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  modality TEXT NOT NULL DEFAULT 'text',
  embedding_version TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  embedding public.vector NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_rag_embedding_dim CHECK (public.vector_dims(embedding) = dimension),
  PRIMARY KEY (chunk_id, model, modality, embedding_version)
);

CREATE TABLE IF NOT EXISTS public.rag_chunk_access_stats (
  chunk_id UUID NOT NULL,
  access_date DATE NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 1,
  last_access_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, access_date)
);

CREATE TABLE IF NOT EXISTS public.rag_article_active_generations (
  article_id UUID PRIMARY KEY REFERENCES public.knowledge_articles(id) ON DELETE CASCADE,
  active_article_version INTEGER NOT NULL,
  active_indexing_job_id UUID NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_article_version INTEGER,
  previous_deprecated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.pii_mask_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL,
  scope_id UUID NOT NULL,
  token TEXT NOT NULL,
  original_encrypted BYTEA NOT NULL,
  pii_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  UNIQUE (scope_type, scope_id, token)
);

-- indexes (empty tables → non-concurrent OK)
CREATE INDEX IF NOT EXISTS idx_rag_chunks_ts ON public.rag_chunks USING gin (ts);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_trgm ON public.rag_chunks USING gin (content public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_article ON public.rag_chunks (article_id, article_version);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_active ON public.rag_chunks (article_id) WHERE is_active_generation = true;
CREATE INDEX IF NOT EXISTS idx_rag_chunks_status ON public.rag_chunks (status);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_tenant ON public.rag_chunks (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rag_chunks_channel ON public.rag_chunks (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rag_chunks_expires ON public.rag_chunks (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rag_ce_openai_1536 ON public.rag_chunk_embeddings
  USING hnsw ((embedding::public.vector(1536)) public.vector_cosine_ops)
  WITH (m=16, ef_construction=200)
  WHERE model = 'openai-text-3-small' AND modality = 'text' AND dimension = 1536;
