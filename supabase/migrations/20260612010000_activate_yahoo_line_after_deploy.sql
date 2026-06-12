-- ============================================================================
-- yahoo / line を active 化 (credential-gated)
--
-- ⚠️ 適用順序 (codex CONCERN#4): 本 migration は yahoo 受信アダプタ登録
--    (src/channels/yahoo + registry) と line webhook endpoint
--    (/api/channels/line/inbound) を Vercel にデプロイした「後」に適用すること。
--    先に適用すると sync-channels cron が yahoo を no-adapter error 扱いする。
--
-- active 化しても「キー未投入」のうちは受信しない:
--   - yahoo (pull): orchestrator が Core `yahoo_shopping` を解決 → 404 (キー無し) なら
--     graceful skip。キー投入後はコード変更ゼロで次 tick から受信開始。
--   - line (push): webhook endpoint が Core `line_messaging` の channel secret 未投入時は
--     503。secret 投入後はコード変更ゼロで署名検証 → 受信開始。
-- ============================================================================

update public.channels set status = 'active' where code = 'yahoo';
update public.channels set status = 'active' where code = 'line';
