# Origin Core 連携マップ

> 調査日: 2026-07-10
> 調査方法: origin-core のコードを実地調査（grep/精読）。エビデンスは `file:line` で明示。推定は「（推定）」と明記。
> 調査対象: `server/index.ts` / `server/routes.ts` + `server/routes/*`（約50の分割ルーター）/ `server/middleware/auth.ts` / `server/lib/{internal-key,credentialScopedKey}.ts` / `shared/schema.ts` / `shared/types/database.ts` / `migrations/` + `supabase/migrations/` / `server/{corsOrigins,events,externalDb,coreProducts,db,originDb}.ts` / `server/messages/` / `server/drive/` / `.env.example`
>
> このファイルが**正本**。各ツールの `docs/origin-integration-map.md` は tool-template 経由で配布されるコピー（読み取り専用）。編集は origin-core 側で行うこと。

---

## 0. アーキテクチャ概観（B案 = origin-core が唯一の正）

origin-core は 18 ツール群の**ハブ兼マスタデータの唯一の正（Single Source of Truth）**。各ツールは自前DBに**業務データのみ**を持ち、マスタ（商品・組織・ユーザー・LLM設定・接続情報等）は**コピーせず** origin-core の Core API 経由で読み書きする。直接DBアクセスが許されるのは origin-ai のみ（例外）。

```
                       ┌──────────────────────────────────────────────────────┐
   各ツール(17)         │                    origin-core (ハブ)                 │
   ec-manager          │                                                      │
   factory-management  │  ┌───────────────────────────┐  ┌──────────────────┐ │
   origintree-logi ───▶│  │ Core Supabase (共有・1物理DB)│  │ Core API (Express)│ │
   ys-staff-tool       │  │  departments / members     │  │  /api/v1/master/* │ │
   origin-ai (直DB可)   │  │  activity_logs / tools     │◀─┤  /api/v2/*        │ │
   skillquest          │  │  company_knowledge / rag_* │  │  /api/events/ingest│ │
   ...                 │  │  product_groups/products/  │  │  /api/cross-events │ │
                       │  │  product_costs/mall_* (商品)│  │  /api/proxy/*      │ │
   ▲  Core API 経由     │  │  external_service_creds(Vault)│ │  /api/llm/resolve │ │
   │  (INTERNAL_API_KEY)│  └───────────────────────────┘  │  /api/supabase-   │ │
   │                   │  ┌───────────────────────────┐  │    connections/*  │ │
   └───────────────────┤  │ Drizzle Postgres (=同一物理DB)│  └──────────────────┘ │
      イベント/マスタ/    │  │  mall_settings(モール認証)   │                       │
      LLM設定/接続情報    │  │  KPI / product_* (一部)     │  外部: 楽天/Amazon/Yahoo │
                       │  └───────────────────────────┘   auPay/Qoo10/Shopify   │
                       │                                   LINE/Slack/Gmail 等   │
                       └──────────────────────────────────────────────────────┘
```

**重要な事実（旧マップの誤りを訂正）**:
- **物理DBは実質2つ**。①Core/Origin Supabase Postgres（`DATABASE_URL`のDrizzle接続と`CORE_SUPABASE_URL`/`ORIGIN_SUPABASE_URL`のsupabase-js接続は**同一物理DB**への2つのアクセス経路。`shared/schema.ts:1073-1078`）。②`EXTERNAL_SUPABASE_URL`の**別・レガシーDB**（origintree-ec-ops、読み取り専用・ほぼ未使用。`server/externalDb.ts:182-189`）。旧マップの「ローカルPostgreSQL と Supabase の2DB」図は誤解を招くため訂正。
- 商品マスタの**実体は Core Supabase 上の正規化テーブル**（`product_groups→products→product_costs / mall_identifiers / mall_profitability`、整数ID）。`server/coreProducts.ts` が supabase-js で参照する。`shared/schema.ts` の `products`/`product_groups`（varchar-id）は**レガシー定義で実体と不一致**。Drizzleの`products`を商品マスタとみなさないこと（`schema.ts:549-551,657-658`）。

---

## 1. 接続システム／技術（どんな仕組みで繋がっているか）

### 1.1 共有DB — Supabase（Postgres + Auth + pgvector）
- 全ツールの**認証・組織・イベント・ナレッジ**基盤。プロジェクト `fqzsxjhhdzrliuuooqic.supabase.co`（`.env.example`）。
- サーバは **service_role キー**で接続しRLSをバイパス（`server/originDb.ts:10-27` / `server/externalDb.ts:27-36`）。RLS強制後（migration `00031`–`00034`, `20260628*`）は anon キーでの書込は `42501` で失敗するため、書込は service_role 必須（`originDb.ts:11-24`）。
- pgvector を `company_knowledge.embedding` と `rag_*` で使用（`database.ts:379-403,713-731`）。

### 1.2 Core API（内部サーバ間・INTERNAL_API_KEY）
- origin-core が公開する REST API。**内部キー認証は2層**:
  1. **グローバル内部キー** `X-Internal-API-Key` == `INTERNAL_API_KEY`（ローテーション中は `INTERNAL_API_KEY_NEW` も許容。`timingSafeEqual`。`server/lib/internal-key.ts:31-84`）。全内部ルートにフルアクセス。
  2. **ツール別スコープ付きキー**（deny-by-default）: `SCOPED_INTERNAL_ROUTE_PREFIXES`（`/api/v1/master`, `/api/v1/rag`, `/api/ai/capabilities`, `/api/agents`, `/api/embed` 等）でのみ、DBで付与された `internal:read`/`internal:write` スコープに応じて許可（`server/lib/credentialScopedKey.ts:155-289`, `server/middleware/auth.ts:222-253`）。2026-06 のクレデンシャル集中管理でゴッドキーからスコープキーへ移行中。
- グローバルゲート `requireAuth`（`middleware/auth.ts:177-301`）: 非`/api`と公開プレフィックスはスルー。**GET/OPTIONSは全て通す**（RLS依存の設計負債。`auth.ts:190-195`）。変更系は内部キー→スコープキー→Supabase JWT の順で検査。

### 1.3 イベント連携（2系統）
- **旧: `POST /api/events/ingest`** — `x-webhook-secret` == `WEBHOOK_SECRET`（平文比較・HMACではない）。`{source_tool, event_type, actor_email?, payload?}` を受け取り `activity_logs` に記録（`server/routes/external.ts:900-913`, `server/events.ts:3-48`）。`source_tool` は DB `tools` テーブルで動的検証（未知は400）。
- **新: `POST/GET /api/cross-events`** — EC/LO/CO のツール間業務データ交換ハブ。ヘッダ `x-cross-key`、環境変数 `EC_CROSS_KEY`/`LO_CROSS_KEY`/`CO_CROSS_KEY` とCore取得値の二重照合（fail-closed 503）。`cross_tool_events` テーブルに保存・30日purge（`server/routes/crossEvents.ts:37-256`）。
- ツール死活監視 `POST /api/tools/health-check` — 各ツールの `health_check_url` に5秒fetchし `tools.is_healthy` 更新（`events.ts:53-101`）。

### 1.4 メッセージ受信 Webhook（統合インボックス）
公開プレフィックス `/api/messages/webhook/`。全て `messages` テーブルに保存し `activity_logs` に `message.received` を記録。チャネル秘密は Supabase Vault（`external_service_credentials`）から解決（`server/messages/webhooks.ts` / `channelCredentials.ts`）。

| プロバイダ | 認証方式 | 状態 | 出典 |
|---|---|---|---|
| LINE | HMAC-SHA256(raw body, channel_secret) を `x-line-signature` と照合 | 稼働 | `webhooks.ts:71-88` |
| Slack | URL verification（challenge echo）+ 非同期処理。bot_token は Vault | 稼働 | `webhooks.ts:165-296` |
| Chatwork | `room_id` → `message_channels.external_channel_id` 照合（署名なし） | 稼働 | `webhooks.ts:372-403` |
| LINE WORKS | HMAC-SHA256 を `x-works-signature` と照合（**fail-closed**・401） | 稼働 | `webhooks.ts:472-502` |
| Gmail | Google Pub/Sub push → `gmail.ts handleGmailPubSubWebhook`（分類・返信あり） | **稼働**（旧マップの「スタブ」は誤り） | `webhooks.ts:630-633`, `gmail.ts:292-536` |
| WeChat | `echostr` 応答のみ | **スタブ（未実装）** | `webhooks.ts:621-627` |

### 1.5 OAuth
| 対象 | 方式 | トークン保管 | 出典 |
|---|---|---|---|
| Google Drive（ユーザー単位） | OAuth2 `access_type=offline`+`prompt=consent`、scope `drive.readonly`。5分バッファで自動更新 | `user_integrations` テーブル（user_id, provider='google'） | `server/drive/oauth.ts:26-130` |
| Yahoo（YConnect v2） | OAuth2（Basic `client_id:secret`）、`authorization_code`/`refresh_token` | `mall_settings` の `yahooAccessToken`/`yahooRefreshToken` 等 | `server/routes/yahoo.ts:29,88-173` |
| Amazon SP-API（LWA） | `grant_type=refresh_token`（client_id/secret/refresh_token） | リクエスト body / mall_settings | `server/routes/amazon.ts:13-22` |
| Shopify | OAuth `oauth/start`→`callback`、トークン発行/更新/状態確認 | Shopify設定（`external.ts`） | `server/routes/external.ts:234-454` |
| Google Sheets | サービスアカウント JWT（`GOOGLE_SERVICE_ACCOUNT_*`）、fallback で Replit connector | — | `server/googleSheets.ts:6-109` |

### 1.6 モール接続（EC各社）
認証情報は **`mall_settings` テーブル（Drizzle/ローカルPostgres）**、メッセージチャネル秘密は **Supabase Vault**（別系統）。

| モール | プロトコル | 認証 | 出典 |
|---|---|---|---|
| 楽天 RMS | REST `api.rms.rakuten.co.jp/es/2.0/` | `ESA` ヘッダ=base64(`serviceSecret:licenseKey`)。429リトライ | `server/rakutenRms.ts:6-78` |
| Amazon SP-API | REST + LWA | refresh_token + client_id/secret | `amazon.ts:13-22` |
| Yahoo | REST + YConnect OAuth2 | Bearer access_token | `yahoo.ts:25-42` |
| auPay(Wowma) | REST `api.manager.wowma.jp/wmshopapi` | `Authorization: Bearer <apiKey>` | `aupay.ts:290-322` |
| Qoo10 | REST/QAPI | `GiosisCertificationKey` ヘッダ | `qoo10.ts:20-40` |
| FTP/FTPS | `basic-ftp`（port21、FTPS既定） | host/user/password | `server/ftpClient.ts:17-26` |
| SFTP | `ssh2-sftp-client`（port22） | host/username/password | `server/sftpClient.ts:15-20` |

### 1.7 CORS 自動管理
`server/corsOrigins.ts`。許可オリジン = ①`ALLOWED_ORIGINS`（env）②localhost固定 ③Cloud Run自己オリジン（`VITE_APP_URL`/`CLOUD_RUN_URL`）④**Supabase `tools` テーブルの `dev_url`/`prod_url`（status='active'）** + Vercelプレビュー一致（`<toolname>-...-origin-trees-projects.vercel.app`）。**5分ごとにDB再読込**（`corsOrigins.ts:6-100`）。→ `tools` レジストリへの登録がCORS自動許可に直結。

### 1.8 その他の外部接続
- **origin-ai 連携**: `ORIGIN_AI_URL` + `ORIGIN_AI_API_KEY`（= origin-ai の `INTERNAL_API_SECRET`）。コアちゃんAIは `CORE_ASSISTANT_MODE=origin_ai` で origin-ai 経由応答。日次分析は origin-ai の Vercel cron が `/api/analysis/run-daily-internal` をコールバック（`server/index.ts:302-313`）。
- **Cloud Tasks**: Drive import ワーカー（`GCP_PROJECT_ID`/`CLOUD_TASKS_QUEUE`/`CLOUD_RUN_SERVICE_URL`）。ワーカー認証は OIDC or 内部キー（`server/routes/_auth.ts:80`）。
- **MCP**: `POST /api/mcp`（JSON-RPC 2.0、埋め込み読み取り窓。`tools/call` はハンドラ内で認証。`server/routes/mcp.ts:263-321`）。
- **Embed**: `/embed/*` は署名付き `?token=` で認証（`/api/embed/token` で発行）。

---

## 2. 認証方式まとめ（どの秘密で守られるか）

| 方式 | ヘッダ/手段 | 用途 |
|---|---|---|
| Supabase JWT | `Authorization: Bearer` | ブラウザからの変更系 |
| グローバル内部キー | `X-Internal-API-Key` == `INTERNAL_API_KEY`(/`_NEW`) | サーバ間フルアクセス |
| スコープ付き内部キー | `X-Internal-API-Key`（DBで grant 照合） | ツール別 `internal:read`/`internal:write` |
| Webhook secret | `x-webhook-secret` == `WEBHOOK_SECRET` | `/api/events/ingest` のみ |
| クロスキー | `x-cross-key`（`EC/LO/CO_CROSS_KEY`） | `/api/cross-events` |
| Origin-Core キー | `X-Origin-Core-Key` == `INTERNAL_API_KEY` | `/api/assistant/tools/*`（コアちゃん tool_use） |
| Embed トークン | 署名付き `?token=` | `/embed/*`, `/api/embed/run-doc` |
| OIDC / 内部キー | Cloud Tasks OIDC | `/api/worker/*` |
| プロバイダ署名 | Slack/LINE/LINE WORKS 各方式 | `/api/messages/webhook/*` |

---

## 3. 他ツールから呼ばれるAPI（サーバ間連携の核心）

| エンドポイント | 認証 | 呼び出し元・用途 |
|---|---|---|
| `POST /api/events/ingest` | `x-webhook-secret` | 全ツール → `activity_logs`（イベント集約） |
| `POST/GET /api/cross-events` | クロスキー | EC/LO/CO 業務データ交換 |
| `GET /api/supabase-connections/:toolId` | グローバル or スコープキー | 各ツールが自分の Supabase serviceRoleKey を解決（主に origin-ai 等） |
| `GET /api/credentials/:service_code` | グローバル or scoped grant | 集中クレデンシャル取得 |
| `POST /api/internal/ci/get-credential` | グローバル内部キーのみ | CI パイプライン |
| `GET /api/llm/resolve` | 内部キー | ツールが LLM プロバイダ+キーを解決 |
| `/api/v1/master/*`（read+write） | スコープキー + `ENABLE_MASTER_V1`（write は `X-Tool-Name` 監査） | **商品マスタ SSoT アクセス**（B案の核心） |
| `/api/v2/*` | GET開放 / JWT write | 商品マスタの別アクセス面（coreProducts 経由） |
| `/api/v1/phase/*` | スコープキー | フェーズ判定/確定 |
| `/api/v1/rag/*`（ingest/search/metrics/lookup） | スコープキー | ツール間 RAG |
| `/api/ai/capabilities/*`, `/api/ai/manifest` | 内部キー | AI 能力レジストリ |
| `/api/proxy/*` | 内部キー | Core が ec-manager/factory-management/origintree-logi/ys-staff-tool/ai へ fan-out |
| `/api/sku-sales-metrics`（GET/POST） | スコープキー | ec-manager の日次 upsert + 読取 |
| `/api/analysis/run-daily-internal` | 内部キー | origin-ai Vercel cron → 日次分析 |
| `/api/assistant/tools/:toolName` | `X-Origin-Core-Key` | コアちゃん tool_use |
| `/api/tools/health-check` | 公開 | 死活監視 |

---

## 4. APIエンドポイント一覧（ドメイン別・抜粋）

> ルーターは `server/routes.ts:66-118` で約50ファイルをパス接頭辞なしで `app.use()`。各ファイルが絶対パス `/api/...` を宣言。

- **ヘルス/ログ**（`routes.ts` inline）: `/api/health`, `/api/logs`(+`/product/:id`,`/mall/:mall`)
- **商品/グループ/ブランド/開発者**（`products.ts`）: `/api/products*`（検索/SKU/linked-save/status）, `/api/product-groups*`, `/api/brands*`, `/api/developers*`, `/api/product-status*`
- **モール設定+接続テスト**（`settings.ts`,`amazon/rakuten/yahoo/aupay/qoo10.ts`）: `/api/mall-settings*`（test-ftp/sftp/各モールAPI）, `/api/spreadsheet/*`, 各モールの register/category/export
- **Yahoo OAuth**（`yahoo.ts`）: `/api/yahoo/{status,auth,callback,refresh,register,category-search}`
- **Shopify+外部/Core登録+v2ミラー**（`external.ts` 最大）: `/api/shopify/*`, `/api/external/*`（レガシー）, `/api/core/{test-connection,registration-data,registration-history,settings}`, `/api/v2/*`（商品マスタ read/write）, `/api/events/ingest`, `/api/tools/health-check`, `/api/sales/summary`
- **Core Master v1**（`masterV1.ts`/`masterV1Write.ts`/`costHistoryWrite.ts`/`operationCriteria.ts`）: `GET/PATCH /api/v1/master/{products,product-groups,product-costs,mall-identifiers,mall-profitability,malls,product-mall-settings,product-specs,product-skus,product-listing-content,exchange-rates,...}`, コスト version-switch, operation-criteria
- **フェーズ管理**（`phase.ts`）: `/api/v1/phase/{judge,products,confirm,proposals,generate}`
- **RAG Tier-1**（`ragIngest/ragSearch/ragMetrics/ragLookup.ts`）: `/api/v1/rag/{search,sources:upsert,worker:tick,metrics}`, `/api/v1/search/entities`, `/api/v1/manufacturing/*`
- **AI/LLM**（`ai.ts`,`aiCapabilities.ts`）: `/api/llm/{resolve,models,providers,models-list,web-search-apis,task-defaults,detect-models}`, `/api/tool-ai-settings`, `/api/tool-definitions*`, `/api/ai/{deep-research,suggest-*,generate-catchcopy}`, `/api/ai/manifest`, `/api/ai/capabilities/*`, `/api/trademark-check`
- **アシスタント/エージェント/QA/ワークフロー/ウォーゲーム**: `/api/assistant/*`, `/api/assistant/tools/:toolName`, `/api/agents/*`, `/api/qa/*`, `/api/workflows/*`, `/api/wargame/*`
- **抽出/ナレッジ/データルーター**（`extraction.ts`,`knowledge.ts`,`proposals.ts`）: `/api/extraction/*`, `/api/knowledge*`, `/api/knowledge-candidates*`, `/api/analysis/run-daily(-internal)`, `/api/data-router/proposals*`
- **メッセージ/インボックス/返信ドラフト**（`messages.ts` 113KB）: `/api/messages/webhook/*`, `/api/messages/{reply,ai-reply,sync/slack}`, `/api/message-channels*`, `/api/reply-drafts/*`, `/api/auto-reply-rules*`
- **タスク/スケジュール/オートメーション**: `/api/task-candidates*`, `/api/tasks/*`, `/api/schedules*`, `/api/automations*`
- **メンバー/招待/パーソナル連携**: `/api/members*`, `/api/invitations/*`, `/api/permission-audit-logs`, `/api/personal-connections/*`
- **クレデンシャル/CI/Supabase設定**: `/api/credentials/:service_code`, `/api/admin/credentials*`, `/api/internal/ci/get-credential`, `/api/supabase-projects*`, `/api/supabase-access*`, `/api/supabase-connections/:toolId`
- **Embed/MCP/Drive/QR/クロスイベント/プロキシ/SKU売上**: `/api/embed/*`, `/api/mcp`, `/api/drive/*`, `/api/qr-codes*`, `/api/cross-events*`, `/api/proxy/*`, `/api/sku-sales-metrics`

---

## 5. データ層

### 5.1 DB接続マップ（env → DB → 用途）
| 経路 | 出典 | env | 物理DB | キー | RLS |
|---|---|---|---|---|---|
| Drizzle（直Postgres） | `server/db.ts:7-17` | `DATABASE_URL` | Core/Origin Supabase Postgres | URL内ロール | バイパス（直SQL） |
| Origin client | `server/originDb.ts:10-27` | `ORIGIN_SUPABASE_URL`+`ORIGIN_SUPABASE_SERVICE_KEY`（fallback CORE/VITE） | 同上（同一DB） | service_role | バイパス（ingest/health） |
| Core client | `server/externalDb.ts:27-36` | `CORE_SUPABASE_URL`+`CORE_SUPABASE_SERVICE_KEY` | 同上（同一DB・商品マスタ） | service_role | バイパス（read/write） |
| External client | `server/externalDb.ts:10-19` | `EXTERNAL_SUPABASE_URL`+`EXTERNAL_SUPABASE_ANON_KEY` | 別DB（ec-ops・レガシー） | anon | **読取専用・書込禁止** |

### 5.2 商品マスタ（Model B・Core Supabase 上・正規化・整数ID）
`product_groups → products → product_costs / mall_identifiers / mall_profitability / malls`、加えて `product_field_settings`, `product_specs`, `product_listing_content`（Amazon掲載文SoT）, `product_phase_meta/_history/_proposals`。`server/coreProducts.ts` が supabase-js で参照。フェーズ現行SoTは `product_mall_settings.product_phase`。

### 5.3 Postgres/Drizzle テーブル（`shared/schema.ts`・主要）
`users`(レガシー認証) / `mall_settings`(モール認証・秘密) / `app_settings` / KPI4層(`company_kpis`,`department_kpis`,`user_kpis`,`kpi_action_goals`,`kpi_value_history`) / `spreadsheet_settings` / `ai_settings` / `tool_ai_settings`(共有) / `llm_providers`,`llm_models`,`llm_task_defaults`,`web_search_apis` / `supabase_projects`,`tool_supabase_access`(接続レジストリ) / `brands`,`developers`,`shipping_methods`,`qoo10_categories`,`aupay_categories`,`mall_commission_settings`(マスタ) / `registration_logs`,`product_history` 等（業務）。※`products`/`product_groups`(varchar) はレガシー定義で実体と不一致。

---

## 6. 共有テーブル（全ツール共有・変更前に影響確認必須）
| テーブル | 用途 | 共有経路 |
|---|---|---|
| `departments` | 組織階層 | 全ツールの組織基盤 |
| `members` | ユーザー（auth.users連携、`tool_access`/`is_admin`） | 全ツールの認証・認可基盤 |
| `activity_logs` | 全ツールのイベントログ（月次パーティション） | `/api/events/ingest` 経由で書込 |
| `company_knowledge` | 全社ナレッジ（pgvector） | 全ツール参照 |
| `core_categories` | 共有カテゴリマスタ | マスタ |
| `tools` | ツールレジストリ（URL/webhook_secret/health/uses_apis/user_facing） | CORS自動許可+権限キーの制御面。migration `20260319200000_create_tools.sql` |
| `external_service_credentials`(+definitions/scoped_keys/grants) | Vault暗号化の共有秘密ストア+ツール別スコープキー | 共有秘密プレーン |
| `supabase_projects`/`tool_supabase_access` | ツール→Supabaseプロジェクトのアクセス権 | 接続レジストリ |
| `rag_*`（chunks/embeddings/source_documents 等） | ツール間RAG（`source_document_id`でクロスツール） | `/api/v1/rag/*` |
| 商品マスタ群（`product_groups`/`products`/`product_costs`/`mall_*`）| 商品の唯一の正 | Core API `/api/v1/master/*`, `/api/v2/*` |

---

## 7. 環境変数一覧
`.env.example`（24キー）:
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`（ブラウザ認証）, `CORE_SUPABASE_URL`/`CORE_SUPABASE_SERVICE_KEY`（商品マスタDB）, `EXTERNAL_SUPABASE_URL`/`EXTERNAL_SUPABASE_ANON_KEY`（レガシー外部DB・読取専用）, `ORIGIN_SUPABASE_URL`/`ORIGIN_SUPABASE_SERVICE_KEY`（ingest/CORS/messages）, `APP_URL`, `ALLOWED_ORIGINS`（CORS）, `WEBHOOK_SECRET`（events/ingest）, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`（Drive OAuth）, `GCP_PROJECT_ID`/`CLOUD_TASKS_QUEUE`/`CLOUD_TASKS_LOCATION`/`CLOUD_RUN_SERVICE_URL`/`CLOUD_TASKS_SA_EMAIL`（Cloud Tasks）, `ORIGIN_AI_URL`/`ORIGIN_AI_API_KEY`（origin-ai連携）, `CORE_ASSISTANT_MODE`, `REPLY_ENGINE_MODE`, `DATABASE_URL`（Drizzle）, `FEATURE_SKU_SPECS`/`VITE_FEATURE_SKU_SPECS`。

**コードで使用されるが `.env.example` に未記載（要追記の穴）**:
`INTERNAL_API_KEY`/`INTERNAL_API_KEY_NEW`（内部キー・ローテーション）, `EC_CROSS_KEY`/`LO_CROSS_KEY`/`CO_CROSS_KEY`（クロスイベント）, `VITE_APP_URL`/`CLOUD_RUN_URL`（CORS自己オリジン）, `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_SERVICE_ACCOUNT_KEY(_BASE64)`/`GOOGLE_CREDENTIALS`（Sheets SA）, `SHOPIFY_CALLBACK_URL`, `ENABLE_MASTER_V1`（Master v1 フラグ）。

---

## 8. 登録済みツール
- **コード定数 `SOURCE_TOOLS`**（`shared/types/database.ts:302`、15件）: origin-core, skillquest, origin-ai, image-factory, ys-staff-tool, factory-management, origintree-logi, ec-data-platform, origintree-soumu-portal, lp-generator, minpaku-tool, product-dev-tool, ec-manager, testpilot, origintree-ec-ops。
- **ランタイムの正は DB `tools` テーブル**（`/api/events/ingest` の `source_tool` はこのテーブルで動的検証。`events.ts:17-25`）。`cs-manager` / `kanpeki-print` は `SOURCE_TOOLS` 定数には無いが、`tools` レジストリ行としては存在しうる（tool-template 配布対象は18ツール）。定数=全ツール名簿と断定しないこと。
- クロスイベントハブが認識するのは狭い集合: `ec-manager`, `origintree-logi`, `factory-management`（`crossEvents.ts:37-41`）。

---

## 9. 連携パターン
| パターン | 詳細 |
|---|---|
| イベント集約 | ツール → `POST /api/events/ingest`(`x-webhook-secret`) → `activity_logs` |
| クロスイベント | EC/LO/CO → `/api/cross-events`(`x-cross-key`) → `cross_tool_events`（30日purge） |
| 商品マスタ参照 | ツール → `/api/v1/master/*`(スコープキー) / `/api/v2/*` → Core Supabase（コピー禁止=B案） |
| 接続情報の取得 | ツール → `GET /api/supabase-connections/:toolId` → 自分のSupabase serviceRoleKey |
| 秘密の取得 | ツール → `GET /api/credentials/:service_code` → Vault復号値（scoped grant） |
| AI/LLM設定共有 | ツール → `GET /api/llm/resolve` / `/api/tool-ai-settings` → プロバイダ+キー |
| プロキシ fan-out | Core → `/api/proxy/<tool>/*` → 各ツールAPI集約 |
| CORS自動管理 | `tools` テーブルのURL → 5分ごとに許可リスト反映 |
| メッセージ統合 | LINE/Slack/Chatwork/LINE WORKS/Gmail → `messages` + `activity_logs` |
| AI日次分析 | origin-ai Vercel cron → `/api/analysis/run-daily-internal`(内部キー) |

---

## 10. 要確認事項・既知の負債
- **GET は全て JWT ゲートを通過**（RLS/ハンドラ内チェック依存）— 設計負債（`auth.ts:190`）。一部GETはハンドラ内で内部スコープを再検査（masterV1, sku-sales-metrics）。
- `/api/external/*` と `EXTERNAL_SUPABASE_URL` は**レガシー/ほぼ未使用**（`externalDb.ts:182-189`）。
- WeChat webhook は**スタブ**のまま（`webhooks.ts:621-627`）。
- `.env.example` に内部キー系（`INTERNAL_API_KEY` 等）が未記載 — ドキュメント上の穴。
- `GET /api/supabase-connections/:toolId` の実呼び出し元ツールの網羅は各ツールリポ側の調査が必要（origin-core 単体では確定不可）。
- 商品マスタは Model B（Core Supabase・整数ID）が実体。Drizzle の varchar-id `products`/`product_groups` はレガシーで実体と乖離。
