-- ============================================================================
-- ticket_drafts.is_separated: 構造分離済み (顧客向け専用) ドラフトの印 (additive)
--
-- 設計レビュー: codex CONCERN→修正反映 (2026-06-23)。クロスリポ設計は APPROVE 済 (3 round)。
--
-- 目的: 社内テキスト (根拠ナレッジ + 担当者メモ) が顧客送信欄に絶対入らない構造保証。
--   origin-ai agent `customer-reply-writer` がセンチネルで構造化した出力を cs-manager の
--   split-reply パーサがサーバ側で分離する。`body` が「構造分離した顧客向け本文のみ」で
--   ある行に is_separated=true を立てる。
--
--   - is_separated=true  : body は顧客向け本文のみ (送信安全)。ai_draft/rag の新規はこれ。
--   - is_separated=false : 旧形式 (混在の可能性) or 手動/テンプレ (manual/first_response)。
--
-- 送信安全規約 (アプリ層で強制):
--   - 楽天一般 sweep (sendApprovedDrafts) で送信可能 =
--       source = 'manual' OR (source IN ('ai_draft','rag') AND is_separated = true)
--   - first_response は一般 sweep に乗せず、send-first-response.ts の営業時間ガード付き
--     専用単発経路でのみ送る (一般 sweep への allow-list は営業時間外ガードを迂回し得る)。
--   - 旧 ai_draft/rag (is_separated=false) は承認済でも送信欄に入らず・送信もされない。
--   - 汎用 /drafts POST は ai_draft/rag を is_separated=true 必須にする (parser 迂回防止)。
--
-- additive only: 既存行は DEFAULT false。既存の混在ドラフトは「旧形式 = legacy unsafe」
--   として扱われ、UI/GET/outbound で送信ブロックされる (fail-safe)。
-- ============================================================================

ALTER TABLE public.ticket_drafts
  ADD COLUMN IF NOT EXISTS is_separated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ticket_drafts.is_separated IS
  '構造分離済みフラグ。true=body は顧客向け本文のみ (送信安全)。'
  'false=旧形式(混在の可能性) or 手動/テンプレ。一般 sweep 送信可否: '
  'source=manual OR (source IN (ai_draft,rag) AND is_separated=true)。'
  'first_response は一般 sweep 非対象 (専用経路のみ)。';
