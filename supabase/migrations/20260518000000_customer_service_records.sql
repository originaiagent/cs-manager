-- ============================================================================
-- PR-B: customer_service_records (顧客対応記録)
--   - 顧客への返信・再送・返金・追加発送等の対応履歴を 1 レコード = 1 対応として保存
--   - product_id は Core master の integer ID。NULL 可 (商品紐付け無し対応もある)
--   - product_name_text は手動編集も可能 (Core 由来名のスナップショット用途)
--   - ticket_id は任意 (チケット由来でない記録もあり得る)
--   - RLS 有効、ポリシー無し (service_role のみ書込み可能、UI は内部 API 経由)
-- ============================================================================

create table public.customer_service_records (
  id                  uuid primary key default gen_random_uuid(),
  product_id          integer,
  product_name_text   text not null,
  variation_text      text,
  recipient_name      text not null,
  recipient_honorific text not null default '様',
  order_number        text,
  order_channel       text check (order_channel in ('amazon','rakuten','yahoo','self','other')),
  action_type         text not null check (action_type in ('reply_only','reship_defect','refund_defect','reship_customer','addon_send','relation_send')),
  amazon_gift_amount  numeric,
  reship_tracking     text,
  record_date         date not null,
  line_account        text,
  memo                text,
  defect_type         text,
  ticket_id           uuid references public.tickets(id) on delete set null,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index idx_csr_record_date  on public.customer_service_records (record_date desc);
create index idx_csr_product_id   on public.customer_service_records (product_id) where product_id is not null;
create index idx_csr_ticket_id    on public.customer_service_records (ticket_id) where ticket_id is not null;
create index idx_csr_action_type  on public.customer_service_records (action_type);

create trigger trg_csr_updated_at
  before update on public.customer_service_records
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.customer_service_records enable row level security;
