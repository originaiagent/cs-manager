-- embed MCP write capability 有効化: 追加移行 (additive only — 既存テーブルの drop/alter なし)
-- 正本: minpaku-tool/supabase/migrations/0004_embed_mcp.sql + 0005_embed_idempotency_status.sql
-- claude-code 生成・codex 設計レビュー APPROVE (2026-06-08)
-- ──────────────────────────────────────────────────────────────────────────────
-- 追加テーブル:
--   ai_embed_idempotency  — MCP write の冪等キー管理 (status lifecycle 込み)
--   ai_embed_form_gates   — フォーム単位の write_enabled ゲート
-- 対象 form: customer_record (customer_service_records.memo)。contract test green 済で有効化。
-- ──────────────────────────────────────────────────────────────────────────────

-- 1) ai_embed_idempotency
--    MCP write の idempotency_key を記録して再送重複を防ぐ。
--    service_role 経由のみアクセス (RLS 有効・ポリシー無し = デフォルト deny)。
create table if not exists public.ai_embed_idempotency (
  idempotency_key text primary key,
  run_id          text not null,
  result_json     jsonb not null default '{}',
  status          text not null default 'pending',
  created_at      timestamptz not null default now()
);

-- TTL 管理のためのインデックス (created_at でのパージ用)
create index if not exists ai_embed_idempotency_created_at_idx
  on public.ai_embed_idempotency (created_at);

-- key + status ルックアップ高速化 (例: WHERE status='completed')
create index if not exists ai_embed_idempotency_status_idx
  on public.ai_embed_idempotency (idempotency_key, status);

alter table public.ai_embed_idempotency enable row level security;
-- ポリシー無し = anon/authenticated はデフォルト deny。service_role はバイパス。

comment on table public.ai_embed_idempotency is
  'MCP write の冪等キー台帳。同一 idempotency_key の再送を防ぐ。';
comment on column public.ai_embed_idempotency.status is
  'Lifecycle state. ''pending'' = reserved but apply not yet complete (do not replay as success). '
  '''completed'' = apply succeeded; result_json holds the canonical result.';

-- 2) ai_embed_form_gates
--    フォーム単位の write_enabled ゲート。
--    contract test 合格後に write_enabled = true に更新する。初期値は false (fail-closed)。
create table if not exists public.ai_embed_form_gates (
  form_id       text primary key,
  write_enabled boolean not null default false,
  updated_at    timestamptz not null default now()
);

alter table public.ai_embed_form_gates enable row level security;
-- ポリシー無し = anon/authenticated はデフォルト deny。service_role はバイパス。

comment on table public.ai_embed_form_gates is
  'MCP フォーム単位の write_enabled ゲート。contract test 合格形式のみ true。';

-- 初期シード: customer_record フォームを write_enabled=true で登録 (この 1 form のみ)。
-- contract test green 済のため有効化する。
insert into public.ai_embed_form_gates (form_id, write_enabled)
values ('customer_record', true)
on conflict (form_id) do update set write_enabled = excluded.write_enabled, updated_at = now();
