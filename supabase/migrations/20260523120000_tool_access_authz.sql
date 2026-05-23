-- ============================================================================
-- 認可モデル刷新: roles 配列 → tool_access['cs-manager'] (fail-closed)
--
-- 適用対象: cs-manager 自身の Supabase (jpnsoqzzylahpandbfcz) のみ。Core には適用しない。
--
-- 背景:
--   先行マイグレーション 20260523000000 は live DB に適用済みで、
--   has_role(text) (roles 配列判定) + cs_manager_authenticated_select ポリシー
--   (11 テーブル) を作成している。本マイグレーションはそれらを forward-only に
--   置き換える (旧ファイルは history として保持し、本ファイルが正)。
--
-- 設計 (codex APPROVE 2026-05-23 / tool_access モデル):
--   - PINNED JWT CONTRACT: auth.jwt()->'app_metadata'->'tool_access' は 8 個の
--     ハイフン付きツールキーを持つ jsonb object (キー欠如=false)。is_admin は boolean。
--   - has_tool_access(text): tool_access[tool_key] が厳密に jsonb 'true' か判定 (fail-closed)。
--     ページ層 (middleware) の TOOL_KEY='cs-manager' と同一セマンティクス。
--   - service_role バイパス経路は不変。本番フラグ OFF のため authenticated セッションに
--     tool_access claim は無く、現行データフロー (service_role) に影響しない。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 新ヘルパー: has_tool_access(tool_key) — 厳密 true のみ許可 (fail-closed)
-- ----------------------------------------------------------------------------
create or replace function public.has_tool_access(tool_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' -> 'tool_access' -> tool_key) = 'true'::jsonb,
    false
  );
$$;

comment on function public.has_tool_access(text) is
  'Core JWT app_metadata.tool_access[tool_key] が厳密に true か判定 (Third-Party Auth, fail-closed)。';

-- ----------------------------------------------------------------------------
-- 2. 旧 roles ベースのポリシーを除去し、tool_access ベースで張り直す。
--    旧名 cs_manager_authenticated_select を drop し、新名 csmgr_tool_access_select を作る。
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
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      raise notice 'skip policy: table public.% does not exist', t;
      continue;
    end if;

    -- 旧 roles ベースのポリシー (先行マイグレーションで作成済) を除去。
    execute format(
      'drop policy if exists %I on public.%I',
      'cs_manager_authenticated_select', t
    );
    -- 新 tool_access ベースのポリシーを冪等に張る。
    execute format(
      'drop policy if exists %I on public.%I',
      'csmgr_tool_access_select', t
    );
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_tool_access(%L))',
      'csmgr_tool_access_select', t, 'cs-manager'
    );
  end loop;
end
$$;

-- ----------------------------------------------------------------------------
-- 3. 旧 has_role(text) 関数 (roles 配列判定) を除去 (誤再利用防止)。
--    ※ has_role(text, text) 等の別シグネチャがあれば影響しない (シグネチャ単位 drop)。
-- ----------------------------------------------------------------------------
drop function if exists public.has_role(text);
