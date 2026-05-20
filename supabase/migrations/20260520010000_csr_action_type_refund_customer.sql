-- CSR action_type CHECK 制約に refund_customer を追加
-- 既存 enum: reply_only/reship_defect/refund_defect/reship_customer/addon_send/relation_send
-- 追加: refund_customer
-- (元 CSV "返金（お客様都合）" 163 件を import 時に refund_defect にフォールバック投入していたものを正しく分類するため)
ALTER TABLE public.customer_service_records
  DROP CONSTRAINT IF EXISTS customer_service_records_action_type_check;

ALTER TABLE public.customer_service_records
  ADD CONSTRAINT customer_service_records_action_type_check
  CHECK (action_type = ANY (ARRAY[
    'reply_only'::text,
    'reship_defect'::text,
    'refund_defect'::text,
    'reship_customer'::text,
    'addon_send'::text,
    'relation_send'::text,
    'refund_customer'::text
  ]));

-- 既存データの再分類: CSV 移植時に refund_defect にフォールバック投入された
-- 「返金（お客様都合）」163 件 (memo に [元action: 返金（お客様都合）] が含まれる)
-- を refund_customer に正しく分類し直す。
-- 本番には Supabase MCP 経由で 2026-05-20 に手動 apply 済 (UPDATE 件数 163 件)。
-- ローカル/preview 環境では本 migration 適用時に同じ条件で再現される (idempotent: 既に
-- refund_customer になっている行は WHERE で除外される)。
UPDATE public.customer_service_records
SET action_type = 'refund_customer', updated_at = now()
WHERE action_type = 'refund_defect'
  AND memo LIKE '%[元action: 返金（お客様都合）]%';
