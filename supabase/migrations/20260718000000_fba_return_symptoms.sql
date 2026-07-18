-- ============================================================================
-- FBA 返品 顧客コメント症状分類 (defect-symptom-handoff)
--
-- 適用対象: cs-manager 自身の Supabase のみ。Core には適用しない。
--
-- 背景:
--   FBA Customer Returns レポートの customer-comments 列 (自由記述の日本語) を AI 分類し、
--   「不良・故障」止まりだった原因ラベルを「水が出ない」等の症状レベルへ引き上げる
--   (工場への製品改善要求エビデンスとして使える粒度にする)。
--
-- PII 不変条件 (最重要):
--   customer-comments は自由文字列で氏名・住所・電話番号を含み得る。
--   原文は cs-manager のどのテーブル・ログ・エラーメッセージにも一切保存しない。
--   PII マスク (src/lib/first-response/mask.ts) を通した後の短い症状ラベルのみを
--   fba_return_symptoms.cause_label に保存する (詳細は src/lib/quality/return-comment-classify.ts)。
--
-- 設計 (20260717000000_defect_causes.sql / 20260717020000_defect_classify_claim.sql の続き。
--   同一の RLS / 権限 / search_path 流儀を踏襲する):
--   - fba_return_symptoms: 返品行 (ec-manager 側の生行。cs-manager にコピーテーブルは無い) の
--     識別子 return_key ×症状ラベルの多対多。major_category は ticket_defect_causes と同一 CHECK。
--   - fba_return_classify_state: 分類済み管理 (二重分類・無限リトライ防止)。ec-manager から
--     都度取得する候補配列 (return_key[]) に対して原子的クレームするための state テーブル
--     (tickets.classify_claimed_at 相当をこちらは専用テーブルで持つ。返品行はローカル DB に
--     存在しないため tickets のようにカラム追加はできない)。
--   - claim_fba_return_classify_batch: claim_defect_classify_batch を範囲配列版にしたもの。
--     overlapping cron 実行での二重分類・同義ラベル増殖を防ぐため、候補配列を state へ
--     upsert してから「取得と同時に lease を打つ」原子的クレームを行う (for update skip locked)。
--   - RLS: 有効化 + csmgr_tool_access_select (fail-closed)。書込みは service_role のみ。
--   - 関数: SECURITY INVOKER (既定) のまま、search_path = '' 固定、非 catalog オブジェクトは
--     完全修飾。PUBLIC/anon/authenticated の execute を revoke し service_role のみ grant。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. fba_return_symptoms: 返品行 (return_key) × 症状ラベル (多対多)
-- ----------------------------------------------------------------------------
create table public.fba_return_symptoms (
  id             uuid primary key default gen_random_uuid(),
  return_key     text not null,          -- ec-manager 返品行の識別子 (orderId|sku|returnDate)
  cause_label    text not null,          -- 正規化済み症状ラベル (例: 水が出ない)
  major_category text not null check (major_category in
    ('function_defect','damaged','missing_part','size_mismatch','color_mismatch','description_mismatch','other')),
  source         text not null default 'ai' check (source in ('ai','manual')),
  created_at     timestamptz not null default now(),
  -- 同一返品行への同一ラベル二重付与を防止 (分類 cron の冪等 upsert キー)
  unique (return_key, cause_label)
);

comment on table public.fba_return_symptoms is
  'FBA返品の顧客コメントをAI分類した症状ラベル。顧客コメント原文は保存しない (PIIマスク後の分類ラベルのみ)。';

create index idx_fba_return_symptoms_return_key
  on public.fba_return_symptoms (return_key);

-- ----------------------------------------------------------------------------
-- 2. fba_return_classify_state: 分類済み管理 (再分類・無限リトライの抑止)
--    返品行はローカル DB に存在しない (ec-manager 保有) ため、tickets のような
--    カラム追加ではなく専用の管理テーブルで lease/attempts を持つ。
-- ----------------------------------------------------------------------------
create table public.fba_return_classify_state (
  return_key    text primary key,
  classified_at timestamptz,
  attempts      integer not null default 0,
  claimed_at    timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.fba_return_classify_state is
  'FBA返品コメント分類 cron のクレーム管理 (lease/attempts)。claim_fba_return_classify_batch 専用。';

-- ----------------------------------------------------------------------------
-- 3. RLS: 有効化 + 既存業務テーブルと同一の SELECT ポリシー (fail-closed)
-- ----------------------------------------------------------------------------
alter table public.fba_return_symptoms enable row level security;

drop policy if exists csmgr_tool_access_select on public.fba_return_symptoms;
create policy csmgr_tool_access_select on public.fba_return_symptoms
  for select to authenticated using (public.has_tool_access('cs-manager'));

alter table public.fba_return_classify_state enable row level security;

drop policy if exists csmgr_tool_access_select on public.fba_return_classify_state;
create policy csmgr_tool_access_select on public.fba_return_classify_state
  for select to authenticated using (public.has_tool_access('cs-manager'));

-- ----------------------------------------------------------------------------
-- 4. claim_fba_return_classify_batch: 候補配列に対する原子的クレーム
--
--    claim_defect_classify_batch (tickets のローカルテーブルを直接 for update skip locked)
--    と異なり、対象は cron 呼び出し側が ec-manager から都度取得する候補配列 (p_keys) のため、
--    まず候補を state へ upsert (未知の return_key を初出登録) してから、同一関数内の
--    後続ステートメントで対象を原子的にクレームする (2 ステートメントに分離: 同一 WITH 節内で
--    データ変更 CTE 同士を連結すると sibling CTE 間の可視性が保証されないため、これを避ける)。
-- ----------------------------------------------------------------------------
create or replace function public.claim_fba_return_classify_batch(
  p_keys text[],
  p_limit int,
  p_max_attempts int,
  p_lease_minutes int
)
returns table (return_key text, attempts integer)
language sql
set search_path = ''
as $$
  insert into public.fba_return_classify_state (return_key)
  select k from pg_catalog.unnest(p_keys) as k
  on conflict (return_key) do nothing;

  with c as (
    select s.return_key
    from public.fba_return_classify_state s
    where s.return_key = any (p_keys)
      and s.classified_at is null
      and s.attempts < p_max_attempts
      and (
        s.claimed_at is null
        or s.claimed_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_lease_minutes)
      )
    order by s.created_at asc
    limit p_limit
    for update skip locked
  )
  update public.fba_return_classify_state s
  set claimed_at = pg_catalog.now(),
      attempts = s.attempts + 1
  from c
  where s.return_key = c.return_key
  returning s.return_key, s.attempts;
$$;

comment on function public.claim_fba_return_classify_batch(text[], int, int, int) is
  '候補 return_key 配列を state へ upsert した上で原子的にクレームして返す (lease + skip locked)。attempts はクレーム時点で +1 済。service_role 専用。';

-- ----------------------------------------------------------------------------
-- 5. 実行権限: Postgres 既定の PUBLIC execute を剥がし service_role のみに絞る (fail-closed)
-- ----------------------------------------------------------------------------
revoke all on function public.claim_fba_return_classify_batch(text[], int, int, int) from public;
revoke all on function public.claim_fba_return_classify_batch(text[], int, int, int) from anon;
revoke all on function public.claim_fba_return_classify_batch(text[], int, int, int) from authenticated;
grant execute on function public.claim_fba_return_classify_batch(text[], int, int, int) to service_role;
