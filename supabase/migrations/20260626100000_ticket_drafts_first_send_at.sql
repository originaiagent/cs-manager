-- ticket_drafts に first_send_at (最初に送信 claim した時刻) を加法追加。
--
-- 背景 (LINE 送信 / codex review P2 2026-06-26):
--   LINE の X-Line-Retry-Key 重複防止窓は「最初の送信」から 24h。送信失敗→stale 再回収→再 claim を
--   繰り返すと updated_at が毎回更新され、24h 終端判定 (updated_at 基準) に永久に到達しない。
--   その結果 retry-key 失効 (>24h) 後に同一 draft を再 push し顧客へ二重配信し得る。
--   → 不変の first_send_at を保持し、24h 終端判定はこれを基準にする (updated_at は 15分 stuck 検知用に温存)。
--
-- 加法的・nullable。既存行は null (送信前)。可逆 (列 drop で戻せる)。

alter table public.ticket_drafts
  add column if not exists first_send_at timestamptz;

comment on column public.ticket_drafts.first_send_at is
  'LINE等: 最初に送信 claim した時刻 (不変)。retry-key 24h 失効判定の基準。再 claim で更新しない。';
