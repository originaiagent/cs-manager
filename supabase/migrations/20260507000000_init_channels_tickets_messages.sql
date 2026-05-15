-- ============================================================================
-- Phase 1.1: チャネル取込基盤
-- channels / channel_credentials / tickets / messages / channel_sync_state
-- 設計原則:
--   - UUID PK, gen_random_uuid()
--   - timestamptz, NOT NULL DEFAULT now() で created_at/updated_at
--   - updated_at は moddatetime トリガで自動更新
--   - RLS 全テーブル ENABLE、ポリシー無し（service_role のみ通す。anon/authenticated は遮断）
--   - 重複排除: (channel_id, external_id) / (ticket_id, channel_message_id)
--   - CHECK 制約: status / direction
-- ============================================================================

-- 拡張機能（gen_random_uuid 用）
create extension if not exists pgcrypto;
-- moddatetime（updated_at 自動更新トリガ用）
create extension if not exists moddatetime schema extensions;

-- ============================================================================
-- channels: チャネル定義
-- ============================================================================
create table public.channels (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  display_name text not null,
  status       text not null default 'active'
                check (status in ('active', 'inactive')),
  config       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger trg_channels_updated_at
  before update on public.channels
  for each row execute procedure extensions.moddatetime(updated_at);

-- 楽天 R-MessE seed
insert into public.channels (code, display_name, status, config)
values (
  'rakuten',
  '楽天 R-MessE',
  'active',
  jsonb_build_object(
    'api_base', 'https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api',
    'page_limit', 100,
    'request_delay_ms', 200,
    'lookback_minutes', 15
  )
);

-- ============================================================================
-- channel_credentials: 認証情報
--   - 同一 channel に複数行を許容（valid_from で世代管理、最新を使用）
--   - RLS により anon/authenticated からは見えない（service_role のみ）
--   - Phase 4 で Supabase Vault 化予定（Phase 1.1 では平文）
-- ============================================================================
create table public.channel_credentials (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.channels(id) on delete cascade,
  credentials jsonb not null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_channel_credentials_channel_validity
  on public.channel_credentials (channel_id, valid_from desc);

create trigger trg_channel_credentials_updated_at
  before update on public.channel_credentials
  for each row execute procedure extensions.moddatetime(updated_at);

-- ============================================================================
-- tickets: チケット
-- ============================================================================
create table public.tickets (
  id               uuid primary key default gen_random_uuid(),
  channel_id       uuid not null references public.channels(id) on delete restrict,
  external_id      text not null,
  customer_name    text,
  customer_email   text,
  subject          text,
  status           text not null default 'untouched'
                     check (status in ('untouched', 'in_progress', 'done')),
  product_id       text,
  case_category    text,
  defect_type      text,
  resolved_at      timestamptz,
  is_kb_candidate  boolean not null default false,
  assignee_user_id uuid,
  channel_meta     jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (channel_id, external_id)
);

create index idx_tickets_status            on public.tickets (status);
create index idx_tickets_channel_status    on public.tickets (channel_id, status);
create index idx_tickets_created_at_desc   on public.tickets (created_at desc);

create trigger trg_tickets_updated_at
  before update on public.tickets
  for each row execute procedure extensions.moddatetime(updated_at);

-- ============================================================================
-- messages: メッセージ
--   - channel_message_id は adapter が必ず非NULLで採番する規約（重複排除のため）
--   - inquiry 本体は "inquiry:{inquiryNumber}"
--   - 返信は "reply:{reply.id}"
-- ============================================================================
create table public.messages (
  id                 uuid primary key default gen_random_uuid(),
  ticket_id          uuid not null references public.tickets(id) on delete cascade,
  direction          text not null
                       check (direction in ('inbound', 'outbound')),
  body               text not null,
  sender_name        text,
  sent_at            timestamptz not null,
  channel_message_id text not null,
  attachments        jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  unique (ticket_id, channel_message_id)
);

create index idx_messages_ticket_sent_at on public.messages (ticket_id, sent_at);

-- ============================================================================
-- channel_sync_state: 増分取込ステート
-- ============================================================================
create table public.channel_sync_state (
  id               uuid primary key default gen_random_uuid(),
  channel_id       uuid not null unique references public.channels(id) on delete cascade,
  last_synced_at   timestamptz,
  last_external_id text,
  updated_at       timestamptz not null default now()
);

create trigger trg_channel_sync_state_updated_at
  before update on public.channel_sync_state
  for each row execute procedure extensions.moddatetime(updated_at);

-- ============================================================================
-- RLS: 全テーブルで有効化、ポリシー無し
--   service_role は RLS をバイパスするため、サーバ側書込みは可能
--   anon / authenticated は一切読めない（Phase 1.2 で UI 用ポリシーを追加予定）
-- ============================================================================
alter table public.channels             enable row level security;
alter table public.channel_credentials  enable row level security;
alter table public.tickets              enable row level security;
alter table public.messages             enable row level security;
alter table public.channel_sync_state   enable row level security;
