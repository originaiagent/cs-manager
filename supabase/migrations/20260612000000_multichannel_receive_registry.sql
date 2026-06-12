-- ============================================================================
-- 全モール受信を「Coreにキー投入だけ」で稼働させる: チャネル受信レジストリ (additive)
--
-- 設計レビュー: codex APPROVE (2026-06-12, round2)
--
-- データ駆動の受信宣言を channels.config に足す:
--   - ingestion: 'pull' | 'push_webhook' | 'inbound_webhook'
--   - service_code: Core Vault のサービスコード (pull/push のみ)
--   - scope_key_field: scope_key を引く config キー名 (既定 'scope_key')
--
-- 段階1 調査結論 (公式ドキュメント裏取り):
--   yahoo  = Pull  (externalTalkList/externalTalkDetail, OAuth2 Bearer) → 専用アダプタ
--   line   = Push  (Messaging API webhook, x-line-signature)            → 専用 webhook
--   amazon = 受信APIなし (SP-API Messaging は送信専用) + 承認ゲート       → メール転送
--   aupay  = 公式受信API未確認                                          → メール転送
--   qoo10  = 公式受信API未確認                                          → メール転送
--   own_ec = 自社EC                                                    → メール転送 (既存)
--
-- ※ 本 migration は additive (自専有テーブルのみ)。yahoo/line の active 化は
--    アダプタ/endpoint デプロイ後に別 migration (20260612010000) で適用する
--    (codex CONCERN#4: activation が adapter デプロイに先行すると no-adapter error)。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 未登録チャネル (aupay / qoo10) を追加。受信API未確認のためメール転送に倒す。
--    status=pending (表示のみ・未稼働が正)。
-- ----------------------------------------------------------------------------
insert into public.channels (code, display_name, status, config) values
  ('aupay', 'au PAY マーケット', 'pending',
    jsonb_build_object(
      'ingestion', 'inbound_webhook',
      'note', '公式の受信API未確認 (受注/在庫/出荷のみ)。問い合わせ通知メールを転送して吸収する。'
    )),
  ('qoo10', 'Qoo10', 'pending',
    jsonb_build_object(
      'ingestion', 'inbound_webhook',
      'note', '公式QAPIに問い合わせ受信メソッド未確認。問い合わせ通知メールを転送して吸収する。'
    ))
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 2. yahoo = pull アダプタ宣言 (service_code/scope_key_field)。status はまだ active にしない。
--    store_id (Yahoo ストアアカウント識別子) を scope_key として使う運用。
-- ----------------------------------------------------------------------------
update public.channels
set config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
      'ingestion', 'pull',
      'service_code', 'yahoo_shopping',
      'scope_key_field', 'store_id'
    )
where code = 'yahoo';

-- ----------------------------------------------------------------------------
-- 3. line = push webhook 宣言。受信は /api/channels/line/inbound が x-line-signature 検証で受ける。
--    status はまだ active にしない (activation は別 migration)。
-- ----------------------------------------------------------------------------
update public.channels
set config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
      'ingestion', 'push_webhook',
      'service_code', 'line_messaging'
    )
where code = 'line';

-- ----------------------------------------------------------------------------
-- 4. amazon = 受信APIなし + Buyer-Seller Messaging 承認待ち。メール転送に倒す。pending 維持。
-- ----------------------------------------------------------------------------
update public.channels
set status = 'pending',
    config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
      'ingestion', 'inbound_webhook',
      'note', 'SP-API Messaging は送信専用で受信APIなし。問い合わせ通知メールを転送して吸収する。'
    )
where code = 'amazon';

-- ----------------------------------------------------------------------------
-- 5. own_ec = 自社EC。メール転送経路で受信。自社管理のため active 化 (残作業は inbox 行追加のみ)。
-- ----------------------------------------------------------------------------
update public.channels
set status = 'active',
    config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
      'ingestion', 'inbound_webhook',
      'note', '自社ECの問い合わせメールを inbound webhook へ転送して吸収する。'
    )
where code = 'own_ec';

-- ----------------------------------------------------------------------------
-- 6. rakuten = service_code をハードコードから config 駆動へ是正 (挙動不変)。
--    既存 shop_id を scope_key_field として宣言。ingestion は専用 cron 経路のため pull 明示。
-- ----------------------------------------------------------------------------
update public.channels
set config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
      'ingestion', 'pull',
      'service_code', 'rakuten_rmesse',
      'scope_key_field', 'shop_id'
    )
where code = 'rakuten';
