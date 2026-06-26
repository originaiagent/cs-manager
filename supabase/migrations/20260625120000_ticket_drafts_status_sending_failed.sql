-- ticket_drafts.status に送信状態 'sending' (送信 claim 中) と 'failed' (非リトライ恒久失敗) を加法追加。
--
-- 背景 (LINE 返信送信配線 / codex 設計レビュー APPROVE 2026-06-25):
--   LINE 送信は承認後 cron で push する。codex 指摘により、
--    (1) cron 重複実行での二重送信を防ぐ atomic claim 用に 'sending' を、
--    (2) userId 欠落・恒久 4xx・429 月間上限・stale>24h を無限再送させない終端として 'failed' を、
--   追加する。
--
-- 加法的変更 (既存値 pending/approved/sent/rejected の意味は変えない)。
-- 既存データは pending のみ (送信フロー稼働前)。楽天送信フローは 'sending'/'failed' を使わないため無害。
-- 可逆 (制約を旧定義に戻すだけでロールバック可)。

alter table public.ticket_drafts drop constraint if exists ticket_drafts_status_check;

alter table public.ticket_drafts
  add constraint ticket_drafts_status_check
  check (status in ('pending', 'approved', 'sent', 'rejected', 'sending', 'failed'));
