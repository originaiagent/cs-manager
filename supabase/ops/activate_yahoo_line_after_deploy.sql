-- ============================================================================
-- 【運用スクリプト / 手動適用専用 — 通常の migration ではない】
-- yahoo / line を active 化 (credential-gated)
--
-- ⚠️ これは supabase/migrations/ には置かない (codex コードレビュー #3):
--    timestamped migration として自動適用されると、アダプタ/endpoint デプロイ前に
--    yahoo=active になり sync-channels cron が no-adapter error を起こす恐れがある。
--    よって ops/ 配下の手動適用スクリプトとし、運用手順で「アプリ先行デプロイ」を担保する。
--
-- ⚠️ 適用順序: yahoo 受信アダプタ登録 (src/channels/yahoo + registry) と line webhook
--    endpoint (/api/channels/line/inbound) を Vercel にデプロイした「後」に、
--    supabase MCP (project ID 明示) で手動実行すること。
--
-- active 化しても「キー未投入」のうちは受信しない:
--   - yahoo (pull): orchestrator が Core `yahoo_shopping` を解決 → 404 (キー無し) なら
--     graceful skip。キー投入後はコード変更ゼロで次 tick から受信開始。
--   - line (push): webhook endpoint が Core `line_messaging` の channel secret 未投入時は
--     503。secret 投入後はコード変更ゼロで署名検証 → 受信開始。
-- ============================================================================

update public.channels set status = 'active' where code = 'yahoo';
update public.channels set status = 'active' where code = 'line';
