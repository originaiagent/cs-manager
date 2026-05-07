-- ============================================================================
-- Phase 3.x: ガワ実装用テーブル
--   - sales_stats_cache              (3.1 不良率)
--   - knowledge_articles             (3.2 ナレッジ + RAG 用フィルタ)
--   - improvement_suggestions        (3.3 Q&A/説明書改善)
--   - product_improvement_proposals  (3.4 製品改善)
--
-- 設計原則:
--   - UUID PK / timestamptz / moddatetime トリガで updated_at 自動更新
--   - RLS 全テーブル ENABLE、ポリシー無し (service_role のみ)
--   - knowledge_articles: scope と storage_*_id の整合 CHECK、HNSW index は
--     embedding 空でも作成 (Phase 3.2 最終段で投入予定)
--   - 全テーブル冪等性は ddl 時点では不要 (apply_migration はスキーマ管理)
-- ============================================================================

create extension if not exists pg_trgm;

-- ============================================================================
-- 1) sales_stats_cache
-- ============================================================================
create table public.sales_stats_cache (
  id          uuid primary key default gen_random_uuid(),
  product_id  text not null,
  period      text not null check (period in ('30d','90d','all')),
  sales_count integer not null default 0,
  as_of       timestamptz not null default now(),
  synced_at   timestamptz not null default now(),
  unique (product_id, period)
);
create index idx_sales_stats_cache_product on public.sales_stats_cache (product_id);
alter table public.sales_stats_cache enable row level security;

-- ============================================================================
-- 2) knowledge_articles
-- ============================================================================
create table public.knowledge_articles (
  id                      uuid primary key default gen_random_uuid(),
  storage_scope           text not null check (storage_scope in ('company','store','product')),
  storage_store_id        text,
  storage_product_id      text,
  applies_to_stores       text[] not null default '{}',
  applies_to_products     text[] not null default '{}',
  applies_to_categories   text[] not null default '{}',
  applies_to_defect_types text[] not null default '{}',
  title                   text not null,
  question                text,
  answer                  text,
  body_markdown           text,
  source_ticket_ids       uuid[] not null default '{}',
  embedding               vector(1536),
  tags                    text[] not null default '{}',
  reference_count         integer not null default 0,
  reviewed_by             uuid,
  status                  text not null default 'draft' check (status in ('draft','published','archived')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint chk_kb_scope_storage_consistency check (
    (storage_scope = 'company' and storage_store_id is null and storage_product_id is null) or
    (storage_scope = 'store'   and storage_store_id is not null and storage_product_id is null) or
    (storage_scope = 'product' and storage_product_id is not null)
  )
);
create index idx_kb_scope                on public.knowledge_articles (storage_scope);
create index idx_kb_status               on public.knowledge_articles (status);
create index idx_kb_store                on public.knowledge_articles (storage_store_id) where storage_store_id is not null;
create index idx_kb_product              on public.knowledge_articles (storage_product_id) where storage_product_id is not null;
create index idx_kb_title_trgm           on public.knowledge_articles using gin (title    gin_trgm_ops);
create index idx_kb_question_trgm        on public.knowledge_articles using gin (question gin_trgm_ops);
create index idx_kb_answer_trgm          on public.knowledge_articles using gin (answer   gin_trgm_ops);
create index idx_kb_tags_gin             on public.knowledge_articles using gin (tags);
create index idx_kb_applies_stores_gin   on public.knowledge_articles using gin (applies_to_stores);
create index idx_kb_applies_products_gin on public.knowledge_articles using gin (applies_to_products);
-- HNSW: embedding 空でも作成可、最終段で生成された embedding で機能
create index idx_kb_embedding_hnsw       on public.knowledge_articles using hnsw (embedding vector_cosine_ops);

create trigger trg_kb_updated_at
  before update on public.knowledge_articles
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.knowledge_articles enable row level security;

-- ============================================================================
-- 3) improvement_suggestions
-- ============================================================================
create table public.improvement_suggestions (
  id                  uuid primary key default gen_random_uuid(),
  target_type         text not null check (target_type in ('manual','faq')),
  target_product_id   text,
  current_content_ref text,
  suggested_change    text not null,
  reasoning           text,
  source_data_summary jsonb not null default '{}'::jsonb,
  status              text not null default 'draft' check (status in ('draft','accepted','rejected','editing')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index idx_is_status on public.improvement_suggestions (status);
create index idx_is_target on public.improvement_suggestions (target_type, target_product_id);
create trigger trg_is_updated_at
  before update on public.improvement_suggestions
  for each row execute procedure extensions.moddatetime(updated_at);
alter table public.improvement_suggestions enable row level security;

-- ============================================================================
-- 4) product_improvement_proposals
-- ============================================================================
create table public.product_improvement_proposals (
  id                   uuid primary key default gen_random_uuid(),
  product_id           text not null,
  defect_rate          numeric,
  threshold_at_trigger numeric,
  defect_breakdown     jsonb not null default '{}'::jsonb,
  suggested_changes    jsonb not null default '{}'::jsonb,
  reasoning            text,
  source_ticket_ids    uuid[] not null default '{}',
  status               text not null default 'draft' check (status in ('draft','in_review','accepted','rejected','escalated')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index idx_pip_status  on public.product_improvement_proposals (status);
create index idx_pip_product on public.product_improvement_proposals (product_id);
create trigger trg_pip_updated_at
  before update on public.product_improvement_proposals
  for each row execute procedure extensions.moddatetime(updated_at);
alter table public.product_improvement_proposals enable row level security;
