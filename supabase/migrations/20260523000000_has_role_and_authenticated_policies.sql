-- ============================================================================
-- Third-Party Auth (JWKS) 用 has_role() と authenticated ロール向け追加 RLS ポリシー
--
-- 適用対象: cs-manager 自身の Supabase (jpnsoqzzylahpandbfcz) のみ。Core には適用しない。
--
-- 設計 (codex APPROVE 2026-05-23):
--   - origin-core を IdP とする Third-Party Auth。Core 発行 JWT を cs-manager 側 Supabase が
--     JWKS provider 経由で信頼する (provider 登録はダッシュボード手動作業)。
--   - has_role(text): auth.jwt()->'app_metadata'->'roles' (jsonb 配列) に指定ロールが
--     含まれるかを判定。ページ層 (middleware) の REQUIRED_ROLE='cs_manager' と同一セマンティクス。
--   - 本マイグレーションのポリシーは「追加 (ADDITIVE)」。
--     既存の service_role バイパス経路 (getSupabaseAdmin / サーバ side データアクセス) は不変。
--     よって現行のデータフローには一切影響しない。
--   - authenticated ロールに対する SELECT を has_role('cs_manager') で許可する
--     防御多層 (将来のブラウザ直/ユーザー JWT アクセス向け)。書き込みは引き続き service_role のみ。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- has_role(text): Core JWT の app_metadata.roles に role が含まれるか
-- ----------------------------------------------------------------------------
create or replace function public.has_role(role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' -> 'roles') ? role,
    false
  );
$$;

comment on function public.has_role(text) is
  'Core JWT app_metadata.roles に指定ロールが含まれるか判定 (Third-Party Auth)。';

-- ----------------------------------------------------------------------------
-- authenticated 向け SELECT ポリシー (追加)。
--   - 対象は cs-manager 自身の業務データで RLS 有効なテーブルのみ。
--   - service_role は RLS をバイパスするため本ポリシーの影響を受けない (現行不変)。
--   - RLS 無効テーブル (rag_*, business_hours 等) は対象外 (スコープ外)。
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  cs_tables text[] := array[
    'channels',
    'channel_sync_state',
    'tickets',
    'messages',
    'ticket_drafts',
    'customer_service_records',
    'improvement_suggestions',
    'knowledge_articles',
    'product_improvement_proposals',
    'sales_stats_cache',
    'send_audit'
  ];
begin
  foreach t in array cs_tables loop
    -- 一部テーブルはリポジトリ内 migration 履歴に存在しない (live DB 先行 / 別系統作成) ため、
    -- 実在するテーブルにのみポリシーを張る (空 DB への fresh apply でも失敗しない)。
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      raise notice 'skip policy: table public.% does not exist', t;
      continue;
    end if;

    -- 冪等化: 既存同名ポリシーがあれば作り直す
    execute format(
      'drop policy if exists %I on public.%I',
      'cs_manager_authenticated_select', t
    );
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_role(%L))',
      'cs_manager_authenticated_select', t, 'cs_manager'
    );
  end loop;
end
$$;
