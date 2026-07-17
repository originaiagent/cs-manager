-- ============================================================================
-- 不良分類 harden C1-2: 原子的クレーム (二重分類根治) + 既存ラベル語彙 (小分け防止根治)
--
-- 適用対象: cs-manager 自身の Supabase のみ。Core には適用しない。
--
-- 背景 (本番実データで判明した 2 欠陥):
--   欠陥1 二重分類: runDefectClassification が select (case_category is null) → AI → update
--     の順で、15 分毎 cron の実行が重なると同一チケットを両 run が拾う。AI は毎回表現が
--     揺れるため同義ラベルが増殖する (実測: 「ミラー表面に傷あり」/「ミラー表面に傷がある」)。
--     unique (ticket_id, cause_label) は文字列が異なるため無力。
--     → claim_defect_classify_batch で「取得と同時に lease を打つ」原子的クレームに変える。
--   欠陥2 小分け防止不発: 既存ラベル提示が ticket.product_id 保有時のみだったが、実データは
--     351 件中 28 件 (8%) しか product_id を持たない。92% で語彙提示ゼロ = 毎回新規ラベル。
--     → top_defect_cause_labels でグローバル頻出ラベルを常時提示できるようにする。
--
-- 設計:
--   - additive のみ (drop / 既存カラム alter なし)。20260717000000_defect_causes.sql の続き。
--   - 型は既存 DDL 裏取り済: tickets.id=uuid / subject=text / product_id=text (Core master の
--     文字列 ID) / classify_attempts=integer (20260507000000, 20260717000000)。
--     ※ customer_service_records.product_id は integer で別空間 (20260518000000)。混同禁止。
--   - 認可: 両 RPC とも SECURITY INVOKER (既定) のまま。呼び出しは service_role のみで、
--     service_role は BYPASSRLS のため RLS を透過する。SECURITY DEFINER にすると execute が
--     漏れた際に RLS を迂回する権限昇格経路になるため採用しない (fail-closed)。
--     Postgres 既定の PUBLIC execute を revoke し、service_role にのみ grant する。
--   - search_path = '' 固定 + 非 catalog オブジェクトは完全修飾 (has_tool_access と同じ流儀、
--     20260523120000_tool_access_authz.sql)。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tickets に lease 用カラム追加 (nullable のみ、既存データ影響なし)
--    classify_claimed_at: 分類 cron がクレームした時刻。lease 期限切れで再クレーム可。
-- ----------------------------------------------------------------------------
alter table public.tickets add column if not exists classify_claimed_at timestamptz;

comment on column public.tickets.classify_claimed_at is
  '不良分類 cron のクレーム時刻 (lease)。NULL=未クレーム。lease 期限切れ行は再クレーム可。';

-- 未分類チケットの古い順スキャン用 partial index (クレーム対象は case_category is null のみ)
create index if not exists idx_tickets_classify_pending
  on public.tickets (created_at)
  where case_category is null;

-- ----------------------------------------------------------------------------
-- 2. claim_defect_classify_batch: 原子的クレーム (二重分類の根治)
--
--    「select → update」の間に他 run が割り込む窓を無くすため、対象選択と lease 打刻を
--    単一の UPDATE ... FROM (select ... for update skip locked) で行う。
--    - for update skip locked: 併走 run は既にロック済の行を飛ばして次を取る (待たない)。
--    - lease (classify_claimed_at): クレーム後に落ちた run の行を p_lease_minutes 後に再開放。
--    - classify_attempts はクレーム時点で +1 済。呼び出し側で追加加算しないこと
--      (二重加算すると MAX_CLASSIFY_ATTEMPTS に早期到達して分類機会を失う)。
--    - 戻り値は加算後の classify_attempts (RETURNING は UPDATE 後の値)。
-- ----------------------------------------------------------------------------
create or replace function public.claim_defect_classify_batch(
  p_limit int,
  p_max_attempts int,
  p_lease_minutes int
)
returns table (id uuid, subject text, product_id text, classify_attempts integer)
language sql
set search_path = ''
as $$
  with c as (
    select t.id
    from public.tickets t
    where t.case_category is null
      and t.classify_attempts < p_max_attempts
      and (
        t.classify_claimed_at is null
        or t.classify_claimed_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_lease_minutes)
      )
    order by t.created_at asc
    limit p_limit
    for update skip locked
  )
  update public.tickets t
  set classify_claimed_at = pg_catalog.now(),
      classify_attempts = t.classify_attempts + 1
  from c
  where t.id = c.id
  returning t.id, t.subject, t.product_id, t.classify_attempts;
$$;

comment on function public.claim_defect_classify_batch(int, int, int) is
  '未分類チケットを原子的にクレームして返す (lease + skip locked)。attempts はクレーム時点で +1 済。service_role 専用。';

-- ----------------------------------------------------------------------------
-- 3. top_defect_cause_labels: グローバル頻出ラベル語彙 (小分け防止の根治)
--
--    ticket_defect_causes.cause_label と customer_service_records.defect_type (非空) を
--    union all して label 毎に件数合計。件数降順・label 昇順で p_limit 件。
--    用途は AI プロンプトへの既存語彙提示のみ (症状ラベル = PII 非含有)。
-- ----------------------------------------------------------------------------
create or replace function public.top_defect_cause_labels(p_limit int)
returns table (label text, n bigint)
language sql
stable
set search_path = ''
as $$
  with all_labels as (
    select pg_catalog.btrim(tdc.cause_label) as raw_label
    from public.ticket_defect_causes tdc
    where tdc.cause_label is not null
      and pg_catalog.btrim(tdc.cause_label) <> ''
    union all
    select pg_catalog.btrim(csr.defect_type) as raw_label
    from public.customer_service_records csr
    where csr.defect_type is not null
      and pg_catalog.btrim(csr.defect_type) <> ''
  )
  select a.raw_label, pg_catalog.count(*)::bigint
  from all_labels a
  group by a.raw_label
  order by pg_catalog.count(*) desc, a.raw_label asc
  limit p_limit;
$$;

comment on function public.top_defect_cause_labels(int) is
  '不良原因ラベルの全体頻出語彙 (ticket_defect_causes + customer_service_records)。AI 分類の小分け防止提示用。service_role 専用。';

-- ----------------------------------------------------------------------------
-- 4. 実行権限: Postgres 既定の PUBLIC execute を剥がし service_role のみに絞る (fail-closed)
--    anon/authenticated は RPC 経由で tickets を更新・語彙参照できない。
-- ----------------------------------------------------------------------------
revoke all on function public.claim_defect_classify_batch(int, int, int) from public;
revoke all on function public.claim_defect_classify_batch(int, int, int) from anon;
revoke all on function public.claim_defect_classify_batch(int, int, int) from authenticated;
grant execute on function public.claim_defect_classify_batch(int, int, int) to service_role;

revoke all on function public.top_defect_cause_labels(int) from public;
revoke all on function public.top_defect_cause_labels(int) from anon;
revoke all on function public.top_defect_cause_labels(int) from authenticated;
grant execute on function public.top_defect_cause_labels(int) to service_role;
