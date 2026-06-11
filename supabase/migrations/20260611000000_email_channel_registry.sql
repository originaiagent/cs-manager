-- ============================================================================
-- 段階2: チャネル/メアド データ駆動レジストリ
--   1. channels.status CHECK を拡張 (active/inactive/pending/disabled) — additive
--      - 'inactive' は後方互換のため残置 ('disabled' の旧称扱い)
--      - 'pending' = 配線なしの申請中チャネル (Amazon)、表示のみ
--   2. Amazon を 'pending' に (許可申請中、受信/送信配線なし)
--   3. メール チャネルを inbound webhook 駆動として有効化
--      - status='active' + config.ingestion='inbound_webhook'
--      - pull adapter を持たないため sync-channels orchestrator は skip する
--   4. channel_inboxes: メールアドレス単位の受信レジストリ
--      - 「行追加だけ」でメアドを増やせる (DB登録だけで増やせる構成)
--      - normalized_address (lower+trim) の UNIQUE で大小文字/前後空白の差を吸収
--      - RLS 有効・ポリシー無し (service_role のみ)。自専有テーブルへの additive。
--
-- 設計レビュー: codex APPROVE (2026-06-11)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. channels.status CHECK 拡張 (additive: 既存値は引き続き有効)
-- ----------------------------------------------------------------------------
alter table public.channels
  drop constraint if exists channels_status_check;
alter table public.channels
  add constraint channels_status_check
  check (status in ('active', 'inactive', 'pending', 'disabled'));

-- ----------------------------------------------------------------------------
-- 2. Amazon = pending (許可申請中。adapter/registry/送受信の配線は一切しない)
-- ----------------------------------------------------------------------------
update public.channels
set status = 'pending'
where code = 'amazon';

-- ----------------------------------------------------------------------------
-- 3. メール チャネル = inbound webhook 駆動として有効化
--    config に ingestion マーカを足す (orchestrator は pull adapter 無しを skip)
-- ----------------------------------------------------------------------------
update public.channels
set status = 'active',
    config = coalesce(config, '{}'::jsonb)
             || jsonb_build_object('ingestion', 'inbound_webhook')
where code = 'email';

-- ----------------------------------------------------------------------------
-- 4. channel_inboxes: メアド受信レジストリ
-- ----------------------------------------------------------------------------
create table if not exists public.channel_inboxes (
  id                 uuid primary key default gen_random_uuid(),
  channel_id         uuid not null references public.channels(id) on delete cascade,
  -- 受信アドレス (envelope/original recipient を優先して登録する運用)
  address            text not null,
  -- 照合用の正規化アドレス (生成列)。大小文字差・前後空白を吸収。lookup は本列の等価比較で行う。
  normalized_address text generated always as (lower(btrim(address))) stored,
  status             text not null default 'active'
                       check (status in ('active', 'disabled')),
  config             jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 正規化アドレスの一意制約 (アドレス重複登録を防止)
create unique index if not exists uq_channel_inboxes_normalized_address
  on public.channel_inboxes (normalized_address);

create index if not exists idx_channel_inboxes_channel
  on public.channel_inboxes (channel_id);

create trigger trg_channel_inboxes_updated_at
  before update on public.channel_inboxes
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.channel_inboxes enable row level security;
