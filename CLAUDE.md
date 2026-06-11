# cs-manager

OriginAI マルチチャネル統合カスタマーサポート + AI改善サイクル

## Project Info
- DeployTarget: Vercel
- Core API: https://origin-core-465031496778.asia-northeast1.run.app
- AI API: https://origin-ai-five.vercel.app

## Environment Variables
- `CORE_API_URL`: Core API endpoint
- `INTERNAL_API_KEY`: Shared secret for Core API (X-Internal-API-Key) — credential / master 取得共通
- `ORIGIN_AI_URL`: AI API endpoint
- `ORIGIN_AI_API_KEY`: AI API key
- `ORIGIN_AI_TOOL_NAME`: cs-manager
- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `CRON_SECRET`: Vercel Cron Bearer token (`/api/cron/*` 認可)

### ユーザー認証 (OIDC リダイレクト方式 / origin-core IdP)
- `NEXT_PUBLIC_CORE_AUTH_ENABLED`: `true` でユーザーログインゲート ON (未設定/`true`以外=OFF=現行素通り)。ビルド時インライン。
- `NEXT_PUBLIC_CORE_SUPABASE_URL`: origin-core Supabase base URL。middleware が issuer / JWKS URL を導出。
- `CORE_OAUTH_CLIENT_ID`: cs-manager の OAuth client_id (非 secret)。Edge=middleware が access_token の `client_id` claim を照合する pin。**client ローテーション時はこの env も更新**。callback は Core から実行時取得した client_id で照合するため env 非依存。
- `APP_BASE_URL`: 本番 base URL (例 `https://cs-manager-chi.vercel.app`)。OAuth `redirect_uri` の単一固定生成元 (request Host 由来禁止)。
- OAuth `client_secret` は **env に置かない**。token 交換直前に Core `/api/credentials/originai_oauth?scope_key=cs-manager` から実行時取得 (5 分 TTL)。

外部サービス認証 (楽天 R-MessE 等) は cs-manager 内に持たない。
Core `/api/credentials/:service_code?scope_key=<店舗ID>` 経由で動的取得 (5 分 TTL キャッシュ)。

## Development
```bash
npm install
npm run dev
```

## Diagnostics
- `/api/diag/core`: Check Core API connectivity (requires `X-Diag-Token: $DIAG_TOKEN` header)
- `/api/diag/ai`: Check AI API connectivity (requires `X-Diag-Token: $DIAG_TOKEN` header)

## Cron Jobs (Vercel)
- `/api/cron/sync-channels`: 10分間隔（`*/10 * * * *`）。code='rakuten' を**除く** active channels を順に adapter 実行 → tickets/messages を upsert。
  - 認可: `Authorization: Bearer ${CRON_SECRET}` または手動 `X-Diag-Token: $DIAG_TOKEN`
- `/api/cron/rakuten-sync`: 5分間隔（`*/5 * * * *`）。楽天 R-MessE 専用。受信 (fetchInbox) + 送信 (sendApprovedDrafts) を 1 サイクルで実行。
  - 認可: 上記同パターン
  - 1 サイクルあたり最大送信件数 20 件 (Vercel タイムアウト対策)

## DB Schema (Phase 1.1+)
channels / channel_inboxes / tickets / messages / channel_sync_state / ticket_drafts.
全テーブル RLS 有効、service_role のみ読み書き可（Phase 1.2 で UI 用ポリシー追加予定）。
`channel_credentials` は廃止 (Core /api/credentials 経由に移行済)。
- `channels.status`: `active` | `inactive` | `pending` | `disabled`。`pending`=配線なしの申請中チャネル(表示のみ、例: Amazon)。`inactive`は`disabled`の旧称(後方互換で残置)。
- `channel_inboxes`: メールアドレス単位の受信レジストリ。`address`(envelope/original recipient 推奨) を `lower(btrim(...))` で一意化。`status` active/disabled。**メアドは行追加だけで増やせる**（DB登録だけでチャネル/メアド拡張）。

## Channel Adapters
- `src/channels/_lib/`: ChannelAdapter インターフェース・正規化型・registry
- `src/channels/rakuten/`: 楽天 R-MessE (InquiryManagementAPI) adapter
  - エンドポイント: `https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api/`
  - 認証: `ESA <base64(serviceSecret:licenseKey)>` を Core `/api/credentials/rakuten_rmesse?scope_key=<店舗ID>` 取得結果から構築
  - 受信 (fetchInbox): `src/channels/rakuten/adapter.ts`
  - 送信 (sendApprovedDrafts): `src/channels/rakuten/outbound.ts`
  - **店舗 ID** は `channels.config.shop_id` に格納する運用 (Core API の scope_key と同一)
- **メール (inbound webhook 駆動)**: pull adapter は持たない (registry 非登録)。`channels.code='email'`, `config.ingestion='inbound_webhook'`。sync-channels cron は pull adapter 無しチャネルを skip する。
  - 受信: `POST /api/channels/email/inbound` (認可 tier=`cron`: `Authorization: Bearer ${CRON_SECRET}` または `X-Diag-Token`)。正規化ペイロード `{to, from, from_name?, subject?, text, message_id, received_at?, in_reply_to?, references?, thread_id?}`。body サイズ・スキーマ検証、ログ/エラーに PII を出さない。
  - 経路: 宛先(`to`)を `channel_inboxes`(active) で解決 → `src/lib/sync/ingest.ts` で ticket+inbound message を冪等 upsert → origin-ai RAG (`src/lib/rag/reply-adapter.ts`) で返信ドラフト生成 → `ticket_drafts(source='rag', status='pending')` 保存。同一 Message-ID 再送はドラフト二重生成しない。
  - 送信 (SMTP 等): **未実装**。`email_send_enabled` は将来のゲート項目。実送信はどの cron にも配線していない。
  - 本番で実フォワーダ(IMAP poller / SendGrid Inbound Parse 等)を繋ぐ際は、同一正規化契約に写像する thin adapter を足し、webhook 認可を専用 secret へ切替える (ゲート項目)。

Note: spec で示された `_diag` は Next.js App Router の private folder 規約 (アンダースコアプレフィックスはルーティングから除外) と衝突するため `diag` に変更。
