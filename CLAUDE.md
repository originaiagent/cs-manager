# cs-manager

OriginAI マルチチャネル統合カスタマーサポート + AI改善サイクル

## Project Info
- DeployTarget: Vercel
- Core API: https://origin-core-465031496778.asia-northeast1.run.app
- AI API: https://origin-ai-five.vercel.app

## Environment Variables
- `CORE_API_URL`: Core API endpoint
- `CORE_CREDENTIAL_KEY`: per-tool scoped 入口鍵 (X-Internal-API-Key)。Core への outbound (credential / master 取得) の唯一の entry 鍵。接続鍵 Core 集約 Done-1 で旧 global `INTERNAL_API_KEY` を置換。inbound 検証 (origin-core→/api/ai/*) と self-loop (Server Action→internalFetch→/api/*) の共有内部鍵は Core `core_internal_shared` から実行時取得する (env 直読みなし)。log 禁止。
  - 旧 `INTERNAL_API_KEY` は runtime app code から完全除去済 (env からも除去)。CI/運用 scripts (`scripts/*`) と vendored `templates/*` のみ carve-out として残置。
- `ORIGIN_AI_URL`: AI API endpoint
- `ORIGIN_AI_API_KEY`: AI API key
- `ORIGIN_AI_TOOL_NAME`: cs-manager
- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `CRON_SECRET`: Vercel Cron Bearer token (`/api/cron/*` 認可)
- `CS_MCP_KNOWLEDGE_TOKEN`: MCP `knowledge_search` ツール専用の静的 Bearer トークン (origin-ai の `customer-reply-writer` agent が注入)。go-live は cs-manager と origin-ai に同一値。未設定時 Core credential `cs_mcp_knowledge.token` にフォールバック。`INTERNAL_API_KEY`/`origin_ai_internal` とは別物 (流用禁止)。log 禁止。
- `EC_MANAGER_API_URL`: ec-manager 外部 API base URL (不良率の分母=期間販売数と FBA 返品の取得元)。未設定時は /quality/defect-rate が「販売数取得不可」表示に縮退 (ページは落ちない)。
- `EC_MANAGER_API_KEY`: ec-manager `/api/external/*` の `x-api-key` (= ec-manager 側 `SALES_API_KEY` と同値)。コードは Core credential `ec_manager_sales_api` (5 分 TTL) → env の順で解決するが、**`ec_manager_sales_api` は Core 未登録のため実運用は env が正**の経路 (ec-manager 自身も同じく env 運用。2026-07-17 時点、ec-manager の鍵でも 404 を実測)。Core 登録が済めば env は撤去可。log 禁止。

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
- `/api/diag/yahoo-egress`: Yahoo 固定IPプロキシ経路の疎通確認 (requires `X-Diag-Token`)。proxy 経由で Yahoo 公開ホストへ実リクエストし `{ok, viaProxy, yahooStatus}` を返す。fail-closed で 502。

## Yahoo egress 固定IPプロキシ (送信元IP固定)
- cs-manager → Yahoo API の通信だけを **固定グローバルIP `104.198.123.146`** (GCP asia-northeast1, 東京) 経由で出す。Vercel egress は毎回変わるが Yahoo 利用申請は固定IP登録を要求するため。
- 配線: `src/channels/yahoo/egress.ts` が Core `yahoo_egress_proxy` (host/port/username/password) を `CORE_CREDENTIAL_KEY` 経由で取得し undici `ProxyAgent` を構築 → `YahooTalkClient.fetchImpl` にだけ注入。Next 組込 fetch は HTTPS_PROXY を無視するため dispatcher 明示注入が必須。
- **Yahoo は必ず proxy 経由**。proxy 取得不能時は fail-closed (直 fetch に落とさない=IP漏れ防止、当該 sync はエラー化)。他チャネル (楽天/メール/LINE) は非経由。
- proxy 接続情報のハードコード禁止 (Core が唯一の入手元)。proxy の BasicAuth 値は Core Vault と GCP Secret Manager に同値保持。IaC/運用手順は `infra/yahoo-egress-proxy/`。

## Cron Jobs (Vercel)
- `/api/cron/sync-channels`: 10分間隔（`*/10 * * * *`）。code='rakuten' を**除く** active channels を順に adapter 実行 → tickets/messages を upsert。
  - 認可: `Authorization: Bearer ${CRON_SECRET}` または手動 `X-Diag-Token: $DIAG_TOKEN`
- `/api/cron/rakuten-sync`: 5分間隔（`*/5 * * * *`）。楽天 R-MessE 専用。受信 (fetchInbox) + 送信 (sendApprovedDrafts) を 1 サイクルで実行。
  - 認可: 上記同パターン
  - 1 サイクルあたり最大送信件数 20 件 (Vercel タイムアウト対策)
- `/api/cron/classify-defects`: 15分間隔（`*/15 * * * *`）。未分類 tickets (case_category is null) を古い順に最大 20 件 AI 分類 (PII マスク済テキストのみ origin-ai へ)。defect 時は `ticket_defect_causes` に複数原因 (正規化ラベル+大分類) を保存。skill 名は rag_config `defect_classify_skill` (default `cs_defect_classify`)。
  - 認可: 上記同パターン。前提: migration `20260717000000_defect_causes.sql` 適用済みであること。

## DB Schema (Phase 1.1+)
channels / channel_inboxes / tickets / messages / channel_sync_state / ticket_drafts / ticket_defect_causes (1チケット複数不良原因、AI/手動)。
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
