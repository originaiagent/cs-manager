-- ============================================================================
-- 不良発生率ライブ化 C1-1: ticket_defect_causes + tickets 分類管理カラム
--
-- 適用対象: cs-manager 自身の Supabase のみ。Core には適用しない。
--
-- 設計 (defect-rate-design.md PART C1-1):
--   - ticket_defect_causes: 1 チケット複数不良原因 (多対多)。cause はテーブル正規化せず
--     label 文字列で持つ (ラベルの小分け防止は AI 分類プロンプト側の既存ラベル提示で行う)。
--   - tickets.classified_at / classify_attempts: AI 分類 cron (/api/cron/classify-defects)
--     の進捗・リトライ管理。nullable / default のみの additive 変更 (既存データ影響なし)。
--   - 破壊的変更なし (drop / 既存カラム alter なし)。
--   - RLS: 既存 cs 業務テーブルと同一 (enable + csmgr_tool_access_select,
--     20260523120000_tool_access_authz.sql の tool_access gate パターン)。
--     書込みは service_role のみ (RLS バイパス)。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ticket_defect_causes: チケット×不良原因 (多対多)
-- ----------------------------------------------------------------------------
create table public.ticket_defect_causes (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references public.tickets(id) on delete cascade,
  cause_label    text not null,          -- 正規化済み原因ラベル (例: 水が出ない)
  major_category text not null check (major_category in
    ('function_defect','damaged','missing_part','size_mismatch','color_mismatch','description_mismatch','other')),
  source         text not null default 'ai' check (source in ('ai','manual')),
  created_at     timestamptz not null default now(),
  -- 同一チケットへの同一ラベル二重付与を防止 (分類 cron の冪等 upsert キー)
  unique (ticket_id, cause_label)
);

create index idx_ticket_defect_causes_ticket
  on public.ticket_defect_causes (ticket_id);

-- ----------------------------------------------------------------------------
-- 2. tickets に分類管理カラム追加 (nullable / default のみ、既存データ影響なし)
-- ----------------------------------------------------------------------------
alter table public.tickets add column classified_at timestamptz;
alter table public.tickets add column classify_attempts integer not null default 0;

-- ----------------------------------------------------------------------------
-- 3. RLS: 有効化 + 既存業務テーブルと同一の SELECT ポリシー (fail-closed)
--    anon はポリシー無しで完全 deny。authenticated は tool_access gate の SELECT のみ。
-- ----------------------------------------------------------------------------
alter table public.ticket_defect_causes enable row level security;

drop policy if exists csmgr_tool_access_select on public.ticket_defect_causes;
create policy csmgr_tool_access_select on public.ticket_defect_causes
  for select to authenticated using (public.has_tool_access('cs-manager'));
