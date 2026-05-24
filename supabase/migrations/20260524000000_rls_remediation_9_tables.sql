-- ============================================================================
-- RLS remediation: RLS 無効だった 9 public テーブルを締める (root-cause fix)
--
-- 適用対象: cs-manager 自身の Supabase (jpnsoqzzylahpandbfcz) のみ。Core には適用しない。
-- CORE_AUTH 本番フラグは触らない (cutover GO は別管理)。cs-manager は greenfield。
--
-- 背景 (Supabase advisor ERROR):
--   以下 9 テーブルが RLS DISABLED かつ anon/authenticated/service_role すべてに
--   full DML grant の状態だった。特に pii_mask_tokens は機微な token 列を含み
--   sensitive_columns_exposed ERROR の対象。
--     rag_indexing_jobs, rag_chunks, rag_article_active_generations, rag_config,
--     rag_chunk_access_stats, rag_chunk_embeddings, pii_mask_tokens,
--     business_hours, first_response_templates
--
-- root-cause 調査結果:
--   - これら 9 テーブルへアクセスするのは getSupabaseAdmin() = service_role
--     クライアントのみ (RLS バイパス)。internal-API-key ゲート背後のサーバ side。
--   - 唯一の browser/anon クライアント (getCoreAuthBrowserClient) は origin-core の
--     Supabase を指す (auth session 参照専用)。cs DB ではない。
--   - cs DB の anon key は env に存在するが query クライアント構築には未使用。
--   => anon/authenticated アクセスする正当な理由は存在しない。tightening は安全。
--
-- 設計 (codex APPROVE 2026-05-24, two-stage):
--   - 9 テーブル全てに RLS 有効化。
--   - 内部テーブル (pii_mask_tokens + rag 内部 5 テーブル):
--       anon/authenticated への全 grant を REVOKE。policy は作らない
--       => RLS により anon/authenticated は完全 deny。service_role は RLS バイパスで不変。
--   - 運用 config テーブル (business_hours, first_response_templates, rag_config):
--       既存 cs 業務テーブルの慣習に合わせ、authenticated に SELECT のみ
--       has_tool_access('cs-manager') gate で許可 (将来の browser-read 防御多層)。
--       anon は全 REVOKE。authenticated の書込系も REVOKE (SELECT のみ GRANT し直す)。
--       ※ rag_config は調査の結果、tuning パラメータ/モデル名/feature flag/
--         credential の service_code 参照のみで secret 本体は含まない (HMAC 鍵等は
--         Core credential から都度取得) ため config 扱いで安全。
--   - service_role の grant/バイパスは一切変更しない (現行データフロー不変)。
--   - 冪等化 (テーブル存在チェック + drop policy if exists)。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 内部テーブル: RLS 有効化 + anon/authenticated grant 全 REVOKE (policy なし)
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  internal_tables text[] := array[
    'pii_mask_tokens',
    'rag_indexing_jobs',
    'rag_chunks',
    'rag_article_active_generations',
    'rag_chunk_access_stats',
    'rag_chunk_embeddings'
  ];
begin
  foreach t in array internal_tables loop
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      raise notice 'skip (not exists): public.%', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);
    -- anon/authenticated への一切のアクセスを剥奪。policy は張らない => 完全 deny。
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
  end loop;
end
$$;

-- ----------------------------------------------------------------------------
-- 2. 運用 config テーブル: RLS 有効化 + anon 全 REVOKE
--    + authenticated は SELECT のみ has_tool_access('cs-manager') gate で許可
-- ----------------------------------------------------------------------------
do $$
declare
  t text;
  config_tables text[] := array[
    'business_hours',
    'first_response_templates',
    'rag_config'
  ];
begin
  foreach t in array config_tables loop
    if not exists (
      select 1 from pg_tables where schemaname = 'public' and tablename = t
    ) then
      raise notice 'skip (not exists): public.%', t;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- anon は完全剥奪。
    execute format('revoke all on public.%I from anon', t);
    -- authenticated は一旦全剥奪し、SELECT のみ戻す (書込は service_role のみ)。
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);

    -- SELECT policy を冪等に張り直す (tool_access gate, fail-closed)。
    execute format('drop policy if exists %I on public.%I', 'csmgr_tool_access_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_tool_access(%L))',
      'csmgr_tool_access_select', t, 'cs-manager'
    );
  end loop;
end
$$;
