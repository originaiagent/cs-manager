-- ============================================================================
-- 営業時間外 一次返信フロー (RAG stage2 Phase2)  — flag-off で投入 (本番無効)
--   設計レビュー: codex (手元) CONCERN → 5 指摘を全反映した上で実装
--
-- 内容:
--   1. ticket_drafts.source CHECK に 'first_response' を追加 (ADD のみ)
--   2. ticket_drafts(ticket_id) WHERE source='first_response' の partial UNIQUE
--      index (DB レベル冪等性: 1 ticket に first_response draft は 1 行のみ)
--   3. send_audit テーブル新規 (cs DB)。raw 本文・raw 差込値は保持しない
--      (template_id/version/category/result/config_snapshot/masked_placeholders/
--       body_hash(HMAC)/external_message_id/error_sanitized のみ)
--   4. business_hours 定義の有無を判定する helper
--      has_business_hours_defined(channel_id) — auto-send の追加ガード用
--      (RPC は「未定義 → 時間外(false)」を返すため、未定義のまま flag=true だと
--       24h auto-send になり得る。auto-send は定義の存在を必須条件にする)
--   5. rag_config に first_response 用 flag / 文言キー (DB 駆動、ハードコード禁止)
--
-- 注: RLS は ticket_drafts/既存テーブル同様 service_role のみ。
-- ============================================================================

-- 1. ticket_drafts.source に 'first_response' を追加 (CHECK 再定義 = ADD のみ相当)
ALTER TABLE public.ticket_drafts
  DROP CONSTRAINT IF EXISTS ticket_drafts_source_check;
ALTER TABLE public.ticket_drafts
  ADD CONSTRAINT ticket_drafts_source_check
  CHECK (source IN ('manual', 'ai_draft', 'rag', 'first_response'));

-- 2. DB レベル冪等性: 1 ticket あたり first_response draft は 1 行のみ
--    (同時 cron / 再実行による二重生成・二重送信を制約で防止)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_drafts_first_response_per_ticket
  ON public.ticket_drafts (ticket_id)
  WHERE source = 'first_response';

COMMENT ON INDEX public.uq_ticket_drafts_first_response_per_ticket IS
  '営業時間外一次返信は 1 ticket 1 件まで。二重生成/二重送信を DB レベルで防止 (codex CONCERN #2)';

-- 3. send_audit (cs DB 業務データ。raw PII / rendered body は保持しない)
CREATE TABLE IF NOT EXISTS public.send_audit (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  draft_id            UUID REFERENCES public.ticket_drafts(id) ON DELETE SET NULL,
  channel_id          UUID,
  channel_code        TEXT,
  flow                TEXT NOT NULL DEFAULT 'first_response',  -- 拡張余地
  category            TEXT,                                    -- AI 分類結果 (PII 無)
  template_id         UUID,
  template_version    INTEGER,
  -- result: dry_run=flag off で送信せず / sent=実送信成功 / failed=送信失敗
  --         skipped=営業時間内 or 既送信 or template 無 / blocked=auto-send 前提未充足
  result              TEXT NOT NULL CHECK (result IN ('dry_run','sent','failed','skipped','blocked')),
  -- 差込値はマスク済みのみ ({"customer_name":"<masked>", ...})。raw 顧客名/商品名は入れない
  masked_placeholders JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- rendered body は保持せず HMAC ハッシュのみ (突合用、内容は復元不可)
  body_hash           TEXT,
  -- 送信時 flag / 営業時間判定等のスナップショット (鍵・raw 値は含めない)
  config_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_message_id TEXT,
  -- 送信失敗時のサニタイズ済みエラー (raw PII を含めない、1000 字トリム)
  error_sanitized     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_send_audit_ticket
  ON public.send_audit (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_send_audit_result
  ON public.send_audit (result, created_at DESC);

COMMENT ON TABLE public.send_audit IS
  '送信監査ログ。誰宛(ticket)/template/差込値(マスク済)/時刻/message_id を記録。raw PII・rendered body は保持しない (body_hash=HMAC のみ) (codex CONCERN #5)';

ALTER TABLE public.send_audit ENABLE ROW LEVEL SECURITY;

-- 4. business_hours 定義の存在判定 (auto-send 追加ガード、codex CONCERN #4)
CREATE OR REPLACE FUNCTION public.has_business_hours_defined(
  channel_id_param UUID
) RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.business_hours bh
    WHERE (bh.channel_id = channel_id_param OR bh.channel_id IS NULL)
  );
$fn$;

COMMENT ON FUNCTION public.has_business_hours_defined(UUID) IS
  '当該 channel (または共通) の営業時間定義が 1 件以上あるか。auto-send は定義が存在することを必須条件とする (未定義 → 24h auto-send 防止)';

-- 5. rag_config: first_response 用設定 (DB 駆動、ハードコード禁止)
INSERT INTO public.rag_config (config_key, config_value, description) VALUES
  ('first_response_enabled', 'false', '営業時間外一次返信フロー全体の有効化 (既定 false=投入時無効)'),
  ('first_response_default_category', '"general"', 'AI 分類失敗時の fallback category'),
  ('first_response_classify_model', '"claude-haiku-4-5"', '一次返信 分類モデル (origin-ai 側 skill が解決)'),
  ('first_response_next_business_day_note', '"※ 翌営業日に担当者より改めてご連絡いたします。"', '一次返信末尾に付与する翌営業日連絡の定型文'),
  ('first_response_audit_hmac_service_code', '"first_response_audit_hmac"', 'send_audit body_hash 用 HMAC 鍵の Core credential service_code')
ON CONFLICT (config_key) DO NOTHING;
