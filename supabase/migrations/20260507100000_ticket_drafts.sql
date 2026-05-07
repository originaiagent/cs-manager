-- ============================================================================
-- Phase 1.2: ticket_drafts
--   - チケット返信の下書きを保存する
--   - 1チケットに対して複数下書き（手動 / AI 生成）を時系列で保持
--   - リロード時の復元は「最新行」を採用
--   - source: 'manual' | 'ai_draft'
--   - RLS 有効、ポリシー無し（service_role のみ）
-- ============================================================================

create table public.ticket_drafts (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  body       text not null,
  source     text not null default 'manual'
               check (source in ('manual', 'ai_draft')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_ticket_drafts_ticket_created_at_desc
  on public.ticket_drafts (ticket_id, created_at desc);

create trigger trg_ticket_drafts_updated_at
  before update on public.ticket_drafts
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.ticket_drafts enable row level security;
