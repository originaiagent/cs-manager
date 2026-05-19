-- ============================================================================
-- PR-EF: customer_service_records に親子構造 (variation_id / variation_jan) を追加
--
-- 設計:
--   - product_id は Core product_groups.id (親階層 group ID) に統一する
--   - variation_id は Core products.id (子バリエーション ID)
--   - variation_jan は Core products.jan_code のスナップショット
--
-- 既存データ:
--   既存 product_id は子 products.id を指す可能性あり (PR#16 以前のデータ)。
--   Core 参照が必要なため、scripts/migrate-customer-records-to-parent.ts で別途正規化
--   する (admin script, --dry-run 推奨)。
--   idempotent: variation_id NULL かつ product_id IS NOT NULL のみ対象。
--   移行不可レコードは variation_id に元値退避、product_id=NULL に。
-- ============================================================================

alter table public.customer_service_records add column variation_id integer null;
alter table public.customer_service_records add column variation_jan text null;

comment on column public.customer_service_records.product_id is 'Core product_groups.id (親階層 group ID)';
comment on column public.customer_service_records.variation_id is 'Core products.id (子バリエーション ID)';
comment on column public.customer_service_records.variation_jan is 'Core products.jan_code スナップショット (バリエーションごとの JAN)';
