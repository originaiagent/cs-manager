-- 楽天 R-MessE credential を Core /api/credentials 経由に切り替えるための schema 変更
-- 設計レビュー: Gemini APPROVE (2026-05-07)
--
-- 変更点:
--   1. channel_credentials テーブル削除 (データ 0 件確認済 / Vault 化に伴い廃止)
--   2. ticket_drafts に承認フロー + 送信結果カラム追加
--      - status (pending/approved/sent/rejected) CHECK 制約付き
--      - sent_at timestamptz NULL
--      - external_message_id text NULL (楽天側 reply.id を保管)
--      - last_error text NULL (送信失敗時のエラー記録)
--   3. channels.config に shop_id を追加するシード/UPDATE は本 migration では行わない
--      (rakuten 店舗 ID は環境固有のため、運用窓で別途投入)

-- 1. channel_credentials drop
DROP TABLE IF EXISTS public.channel_credentials;

-- 2. ticket_drafts 拡張
ALTER TABLE public.ticket_drafts
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'sent', 'rejected'));

ALTER TABLE public.ticket_drafts
  ADD COLUMN IF NOT EXISTS sent_at timestamptz NULL;

ALTER TABLE public.ticket_drafts
  ADD COLUMN IF NOT EXISTS external_message_id text NULL;

ALTER TABLE public.ticket_drafts
  ADD COLUMN IF NOT EXISTS last_error text NULL;

-- approved → sent への遷移を高速に絞り込むため複合インデックスを追加
CREATE INDEX IF NOT EXISTS idx_ticket_drafts_status_ticket
  ON public.ticket_drafts (status, ticket_id);

COMMENT ON COLUMN public.ticket_drafts.status IS
  'pending=未確定 / approved=送信待ち / sent=送信済 / rejected=却下。outbound adapter は approved → sent 遷移のみ扱う';
COMMENT ON COLUMN public.ticket_drafts.external_message_id IS
  '楽天 reply.id 等。POST 直後は regdate fallback (regdate:<regDate>) を入れ、後続 GET で本物 id に上書きする運用';
COMMENT ON COLUMN public.ticket_drafts.last_error IS
  '送信失敗時のエラーメッセージ (1000 文字でトリム)。次回再試行のための診断情報';
