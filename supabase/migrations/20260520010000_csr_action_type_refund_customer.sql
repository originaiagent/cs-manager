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
