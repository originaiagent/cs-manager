# Origin Core 連携マップ

> 調査日: 2026-03-26
> 調査対象: server/routes.ts, shared/schema.ts, shared/types/database.ts, supabase/migrations/, server/corsOrigins.ts, .env.example

---

## 1. APIエンドポイント一覧

### ヘルス・ステータス

| パス | メソッド | 概要 | 他ツールから呼ばれるか |
|------|--------|------|------------------|
| `/api/health` | GET | サーバー稼働確認（uptimeを返す） | 要確認（ヘルスチェック用途で可能性あり） |
| `/api/tools/health-check` | POST | 登録済み全ツールのヘルスチェックを実行 | 不明 |

### 製品管理（レガシー）

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/products` | GET | 製品一覧取得 |
| `/api/products/search` | GET | クエリによる製品検索 |
| `/api/products/:id` | GET | 製品1件取得 |
| `/api/products/sku/:sku` | GET | SKUによる製品取得 |
| `/api/products` | POST | 製品作成 |
| `/api/products/:id` | PUT | 製品更新 |
| `/api/products/:id` | DELETE | 製品削除 |
| `/api/products/:id/linked-save` | PUT | リンク保存付き更新 |
| `/api/products/:id/status/:mall` | PATCH | モール別ステータス更新 |

### 製品グループ

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/product-groups` | GET | 製品グループ一覧 |
| `/api/product-groups/:managementNumber` | GET | 管理番号でグループ取得 |
| `/api/product-groups/:managementNumber` | PUT | グループ更新 |
| `/api/product-groups/:managementNumber/products` | GET | グループ内製品一覧 |
| `/api/product-groups/generate` | POST | グループ自動生成 |

### ログ

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/logs` | GET | 全ログ取得（limit付き） |
| `/api/logs/product/:productId` | GET | 製品別ログ |
| `/api/logs/mall/:mall` | GET | モール別ログ |
| `/api/logs` | POST | ログ作成 |

### スプレッドシート連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/spreadsheet/settings` | GET/POST | スプレッドシート設定の取得・保存 |
| `/api/spreadsheet/sheets` | GET | URLからシート名一覧取得 |
| `/api/spreadsheet/headers` | GET | シートのカラムヘッダー取得 |
| `/api/spreadsheet/sync` | POST | スプレッドシートからデータ同期 |

### モール設定（FTP/API認証情報）

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/mall-settings` | GET | 全モール設定取得 |
| `/api/mall-settings/:mallName` | GET | 特定モール設定取得 |
| `/api/mall-settings` | POST | モール設定作成 |
| `/api/mall-settings/bulk` | POST | モール設定一括作成・更新 |
| `/api/mall-settings/test-ftp` | POST | FTP接続テスト |
| `/api/mall-settings/test-sftp` | POST | SFTP接続テスト |
| `/api/mall-settings/test-rakuten-api` | POST | 楽天API接続テスト |
| `/api/mall-settings/test-yahoo-item-api` | POST | Yahoo APIテスト |
| `/api/mall-settings/test-amazon-api` | POST | Amazon SP-APIテスト |
| `/api/mall-settings/test-aupay-api` | POST | auPay APIテスト |
| `/api/mall-settings/test-qoo10-api` | POST | Qoo10 APIテスト |
| `/api/mall-settings/test-shopify-api` | POST | Shopify APIテスト |

### Yahoo連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/yahoo/status` | GET | Yahoo認証ステータス確認 |
| `/api/yahoo/auth` | GET | OAuthフロー開始 |
| `/api/yahoo/callback` | GET | OAuthコールバック |
| `/api/yahoo/refresh` | POST | Yahooトークンリフレッシュ |
| `/api/yahoo/register` | POST | Yahoo商品登録 |
| `/api/yahoo/category-search` | GET | Yahooカテゴリ検索 |
| `/api/yahoo/keyword-suggestions` | GET | キーワード候補取得 |

### 楽天連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/export/rakuten-csv` | POST | 楽天CSV出力 |
| `/api/export/rakuten-item-cat-csv` | POST | 楽天商品カテゴリCSV出力 |
| `/api/rakuten/keyword-suggestions` | POST | キーワード候補取得 |
| `/api/rakuten/genres/:genreId` | GET | ジャンル情報取得 |
| `/api/mall/rakuten/price/:productId` | GET | 楽天価格取得 |

### auPay連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/export/aupay-item-csv` | POST | auPay商品CSV出力 |
| `/api/export/aupay-stock-csv` | POST | auPay在庫CSV出力 |
| `/api/aupay/register` | POST | auPay商品登録 |
| `/api/aupay/import-categories` | POST | auPayカテゴリインポート |
| `/api/aupay/search-categories` | GET | auPayカテゴリ検索 |

### Qoo10連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/qoo10/import-categories` | POST | Qoo10カテゴリインポート |
| `/api/qoo10/search-categories` | GET | Qoo10カテゴリ検索 |
| `/api/qoo10/categories` | GET | Qoo10カテゴリ一覧 |
| `/api/export/qoo10-excel` | POST | Qoo10 Excel出力 |
| `/api/qoo10/register` | POST | Qoo10商品登録 |

### Shopify連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/shopify/oauth/start` | GET | Shopify OAuth開始 |
| `/api/shopify/callback` | GET | Shopify OAuthコールバック |
| `/api/shopify/settings` | GET/POST | Shopify設定取得・保存 |
| `/api/shopify/token` | POST | Shopifyトークン作成 |
| `/api/shopify/token/refresh` | POST | トークンリフレッシュ |
| `/api/shopify/token/status` | GET | トークンステータス確認 |
| `/api/shopify/test-connection` | GET | 接続テスト |
| `/api/export/shopify-csv` | POST | Shopify CSV出力 |
| `/api/shopify/register` | POST | Shopify商品登録 |
| `/api/shopify/collections` | GET | コレクション一覧 |
| `/api/shopify/collect` | POST | コレクション追加 |

### AI・LLM設定

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/ai-settings` | GET/POST | グローバルAI設定 |
| `/api/llm/models` | GET | LLMモデル一覧 |
| `/api/llm/available` | GET | 利用可能プロバイダー一覧 |
| `/api/llm/providers` | GET/POST | LLMプロバイダー管理 |
| `/api/llm/providers/:id` | PUT/DELETE | プロバイダー更新・削除 |
| `/api/llm/models-list` | GET/POST | モデルリスト管理 |
| `/api/llm/models-list/replace` | POST | モデルリスト一括置換 |
| `/api/llm/models-list/:id` | PUT/DELETE | モデル更新・削除 |
| `/api/llm/web-search-apis` | GET/POST | Web検索API管理 |
| `/api/llm/web-search-apis/:id` | PUT/DELETE | Web検索API更新・削除 |
| `/api/llm/task-defaults` | GET | タスクデフォルトモデル一覧 |
| `/api/llm/task-defaults/:id` | PUT | タスクデフォルト更新 |
| `/api/llm/detect-models` | POST | 利用可能モデル自動検出 |
| `/api/llm/dismiss-model` | POST | モデルを非表示にする |
| `/api/tool-ai-settings` | GET/POST | ツール別AI設定 |
| `/api/tool-definitions` | GET/POST | ツール定義管理 |
| `/api/tool-definitions/:toolId` | PUT/DELETE | ツール定義更新・削除 |

### AI機能

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/ai/deep-research` | POST | ディープリサーチジョブ開始 |
| `/api/ai/deep-research/jobs/:jobId` | GET | ジョブステータス確認 |
| `/api/ai/deep-research/jobs` | GET | ジョブ一覧 |
| `/api/ai/deep-research/test` | POST | ディープリサーチテスト |
| `/api/ai/suggest-color-names` | POST | AI色名提案 |
| `/api/ai/suggest-categories` | POST | AIカテゴリ提案 |
| `/api/ai/generate-catchcopy` | POST | AIキャッチコピー生成 |
| `/api/ai/test-all` | POST | AI機能全テスト |
| `/api/trademark-check` | POST | 商標チェック |

### Supabaseプロジェクト管理（他ツール連携の核心）

| パス | メソッド | 概要 | 他ツールから呼ばれるか |
|------|--------|------|------------------|
| `/api/supabase-projects` | GET | Supabaseプロジェクト一覧 | 要確認 |
| `/api/supabase-projects` | POST | プロジェクト登録 | 要確認 |
| `/api/supabase-projects/:id` | PUT/DELETE | プロジェクト更新・削除 | 要確認 |
| `/api/supabase-access` | GET | ツール→プロジェクトのアクセス権マッピング一覧 | **他ツールが参照する可能性あり** |
| `/api/supabase-access` | POST | アクセス権マッピング作成 | 要確認 |
| `/api/supabase-access/:id` | DELETE | アクセス権マッピング削除 | 要確認 |
| `/api/supabase-connections/:toolId` | GET | 指定ツールのSupabase接続情報取得 | **他ツールから呼ばれる（toolIdがパラメータ）** |

### イベント受信（外部ツールからのWebhook）

| パス | メソッド | 概要 | 他ツールから呼ばれるか |
|------|--------|------|------------------|
| `/api/events/ingest` | POST | 外部ツールからイベントを受信 | **はい。`x-webhook-secret`ヘッダー認証あり。他ツールがactivity_logsに書き込むためのエンドポイント** |

### メッセージ・Webhook受信

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/messages/webhook/line` | POST | LINE Webhook受信 |
| `/api/messages/webhook/slack` | POST | Slack Webhook受信 |
| `/api/messages/webhook/chatwork` | POST | Chatwork Webhook受信 |
| `/api/messages/webhook/wechat` | POST | WeChat Webhook受信（スタブ） |
| `/api/messages/webhook/gmail` | POST | Gmail Webhook受信（スタブ） |
| `/api/messages/reply` | POST | メッセージ返信送信 |
| `/api/messages/ai-reply` | POST | AI生成返信送信 |
| `/api/messages/:id/read` | PATCH | 既読マーク |
| `/api/messages/slack/update-token` | POST | Slackトークン更新 |
| `/api/messages/sync/slack` | POST | Slackメッセージ同期 |

### メッセージチャンネル管理

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/message-channels` | GET/POST | チャンネル一覧・作成 |
| `/api/message-channels/:id` | PUT/DELETE | チャンネル更新・削除 |
| `/api/auto-reply-rules/:channelId` | GET | 自動返信ルール取得 |
| `/api/auto-reply-rules` | POST | 自動返信ルール作成 |
| `/api/auto-reply-rules/:id` | PUT/DELETE | ルール更新・削除 |

### AIアシスタント

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/assistant/chat` | POST | AIアシスタントとチャット |
| `/api/assistant/conversations` | GET | 会話履歴一覧 |
| `/api/assistant/conversations/:id/messages` | GET | 会話メッセージ取得 |

### タスク・候補

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/tasks/ai-suggest` | POST | AIタスク提案 |
| `/api/tasks/check-overdue` | POST | 期限切れタスク確認 |
| `/api/task-candidates/extract` | POST | メッセージからタスク候補抽出 |
| `/api/task-candidates` | GET | タスク候補一覧 |
| `/api/task-candidates/:id/reject` | POST | タスク候補却下 |
| `/api/knowledge-candidates` | GET | ナレッジ候補一覧 |
| `/api/knowledge-candidates/:id/approve` | POST | ナレッジ候補承認 |

### v2 API（正規化スキーマ）

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/v2/product-groups` | GET/POST | 製品グループ管理（v2） |
| `/api/v2/product-groups/:id` | GET | 製品グループ取得（v2） |
| `/api/v2/products` | GET/POST | 製品管理（v2） |
| `/api/v2/products/grouped` | GET | グループ別製品一覧 |
| `/api/v2/products/:id` | GET/PUT | 製品取得・更新 |
| `/api/v2/products/:id/costs` | GET | 製品コスト取得 |
| `/api/v2/products/:id/mall-ids` | GET | モールID取得 |
| `/api/v2/products/:id/profitability` | GET | 収益性取得 |
| `/api/v2/malls` | GET | モール一覧 |
| `/api/v2/team-members` | GET | チームメンバー一覧 |
| `/api/v2/product-groups/:groupId/specs` | GET/PUT | 製品スペック管理 |
| `/api/v2/product-groups/:groupId/factory` | GET | 工場情報取得 |
| `/api/v2/product-groups/:groupId/electrical-specs` | GET/PUT | 電気仕様管理 |
| `/api/v2/product-groups/:groupId/extra-attributes` | GET/POST | 追加属性管理 |
| `/api/v2/product-groups/:groupId/regulations` | GET/PUT | 規制情報管理 |
| `/api/v2/product-groups/:groupId/regulation-checks` | GET/POST | 規制チェック管理 |
| `/api/v2/product-groups/:groupId/inquiries` | GET/POST | 問い合わせ管理 |
| `/api/v2/workflow-steps` | GET | ワークフローステップ一覧 |
| `/api/v2/product-groups/:groupId/progress` | GET/PUT | ワークフロー進捗管理 |

### 外部DB連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/external/products` | GET | 外部製品取得 |
| `/api/external/products/grouped` | GET | 外部製品グループ取得 |
| `/api/external/products/:id` | GET | 外部製品詳細 |
| `/api/external/malls` | GET | 外部モール一覧 |
| `/api/core/test-connection` | GET | Core接続テスト |
| `/api/core/registration-data/:extProductId` | GET | 登録データ取得 |
| `/api/core/registration-data` | POST | 登録データ作成 |
| `/api/core/registration-history/:registrationDataId` | GET | 登録履歴取得 |
| `/api/core/registration-history` | POST | 登録履歴追加 |
| `/api/core/settings/:key` | GET/POST | Core設定取得・保存 |

---

## 2. Supabaseテーブル一覧

Supabaseに存在するテーブル（`supabase/migrations/` および `shared/types/database.ts` から確認）。

| テーブル名 | 概要 | 他ツールと共有 |
|-----------|------|-------------|
| `departments` | 組織部署の階層構造 | **はい**（全ツールの組織管理基盤） |
| `members` | ユーザー情報（Supabase auth.usersと紐付け） | **はい**（全ツールの認証基盤） |
| `activity_logs` | 全ツールからのイベントログ（パーティション分割） | **はい**（`/api/events/ingest` 経由で他ツールが書き込む） |
| `company_knowledge` | 全社ナレッジDB（ベクトル埋め込みあり） | **はい**（全ツールで参照可能） |
| `invitations` | メンバー招待管理 | 要確認 |
| `permission_audit_logs` | 権限変更の監査ログ | 要確認 |
| `tools` | ツールレジストリ（URL、Webhook secret、ヘルスチェックURL等） | **はい**（CORS設定で`dev_url`/`prod_url`を参照） |

> `tools` テーブルはSupabaseに存在するが、migrationファイルには未確認。`corsOrigins.ts`と`shared/types/database.ts`から存在を確認。

---

## 3. PostgreSQLテーブル一覧（Drizzle ORM）

`shared/schema.ts` で定義されているテーブル。origin-coreのローカルPostgreSQLに存在。

| テーブル名 | 概要 |
|-----------|------|
| `users` | レガシー認証（ユーザー名/パスワード） |
| `productGroups` | 管理番号単位の共通製品データ |
| `products` | モール別設定を持つ個別SKU |
| `registrationLogs` | モールへの登録操作ログ |
| `spreadsheetSettings` | Google Sheets連携設定 |
| `mallSettings` | EC各モールのFTP/API認証情報 |
| `appSettings` | アプリ全体設定 |
| `kpiDepartments` | KPI管理の部署グループ |
| `kpiMetrics` | KPI指標（目標値・実績値） |
| `productsNew` | 製品テーブル（v2、正規化スキーマへ移行中） |
| `productMallSettings` | 製品ごとのモール別設定 |
| `productSkus` | 製品のSKUバリエーション |
| `productHistory` | 製品変更履歴・監査ログ |
| `brands` | 製品ブランド（コード付き） |
| `aiSettings` | グローバルAIプロバイダー設定 |
| `toolAiSettings` | ツール別AIモデル設定（`toolId`で識別） |
| `llmProviders` | LLMプロバイダー定義（OpenAI、Anthropic等） |
| `llmModels` | 利用可能LLMモデル（grade: premium/standard/light） |
| `llmDismissedModels` | 非表示にしたモデル |
| `llmTaskDefaults` | タスクタイプ別デフォルトモデル |
| `webSearchApis` | Web検索プロバイダー設定（Brave、Tavily等） |
| `supabaseProjects` | 外部Supabaseプロジェクト定義 |
| `toolSupabaseAccess` | ツール→Supabaseプロジェクトのアクセス権マッピング |
| `developers` | 開発者プロフィール管理 |

---

## 4. 外部連携（Webhook・ツール間API・CORS）

### 4.1 Webhookの受信

| エンドポイント | プロバイダー | 認証方式 | ステータス |
|-------------|-----------|--------|---------|
| `POST /api/messages/webhook/line` | LINE | HMAC-SHA256署名検証 | 実装済み |
| `POST /api/messages/webhook/slack` | Slack | URLベリフィケーション | 実装済み |
| `POST /api/messages/webhook/chatwork` | Chatwork | room_idによる識別 | 実装済み |
| `POST /api/messages/webhook/wechat` | WeChat | echostr検証 | スタブ（未実装） |
| `POST /api/messages/webhook/gmail` | Gmail | - | スタブ（未実装） |

### 4.2 他ツールからのイベント受信

| エンドポイント | 認証方式 | 概要 |
|-------------|--------|------|
| `POST /api/events/ingest` | `x-webhook-secret` ヘッダー（環境変数 `WEBHOOK_SECRET` と照合） | 他ツールがorigin-coreのactivity_logsにイベントを書き込む。`source_tool`（SOURCE_TOOLS定数）と`event_type`（EVENT_TYPES定数）が必要 |

**イベントペイロード形式:**
```json
{
  "source_tool": "skillquest",
  "event_type": "task.created",
  "actor_email": "user@example.com",
  "payload": {}
}
```

### 4.3 他ツールから呼ばれるAPI（ツール連携API）

| エンドポイント | 用途 | 呼び出し元ツール |
|-------------|------|--------------|
| `GET /api/supabase-connections/:toolId` | 指定ツールのSupabase接続情報を取得 | `toolId`を持つ全ツール（要確認） |
| `GET /api/supabase-access` | ツール→Supabaseプロジェクトのアクセス権一覧 | 要確認 |
| `GET /api/tool-ai-settings` | ツール別AIモデル設定を取得 | 要確認 |
| `GET /api/llm/providers` / `GET /api/llm/models-list` | LLMプロバイダー・モデル一覧を取得 | 要確認（AIを使う全ツールが参照する可能性） |

### 4.4 CORS設定

**ソース:** `server/corsOrigins.ts`

| オリジンの供給元 | 詳細 |
|--------------|------|
| 環境変数 | `ALLOWED_ORIGINS`（カンマ区切り。デフォルト: `http://localhost:5001,http://localhost:3000`） |
| Supabase `tools` テーブル | `status='active'`の全ツールの`dev_url`と`prod_url`からoriginを抽出（スキーム+ホスト） |
| ハードコード | `http://localhost:5001`, `http://localhost:3000` |

**更新サイクル:** 5分ごとにDBから再ロード（`startCorsOriginRefresh()`）

**`tools`テーブルへの登録がCORSの自動許可に直結する。**

---

## 5. 環境変数一覧

`.env.example` から確認した全環境変数キー。

| 変数名 | 用途 |
|-------|------|
| `VITE_SUPABASE_URL` | クライアントサイド Supabase URL（フロントエンド用） |
| `VITE_SUPABASE_ANON_KEY` | クライアントサイド Supabase 匿名キー（フロントエンド用） |
| `CORE_SUPABASE_URL` | サーバーサイド Supabase URL |
| `CORE_SUPABASE_SERVICE_KEY` | サーバーサイド Supabase サービスキー（RLS bypassing） |
| `EXTERNAL_SUPABASE_URL` | 外部DBの Supabase URL（`/api/external/` 系エンドポイント用） |
| `EXTERNAL_SUPABASE_ANON_KEY` | 外部DBの Supabase 匿名キー |
| `ORIGIN_SUPABASE_URL` | イベントインジェスト用 Supabase URL（`/api/events/ingest` 用） |
| `ORIGIN_SUPABASE_SERVICE_KEY` | イベントインジェスト用 Supabase service_role キー |
| `ALLOWED_ORIGINS` | CORS許可オリジン（カンマ区切り） |
| `WEBHOOK_SECRET` | `/api/events/ingest` の認証シークレット |
| `DATABASE_URL` | PostgreSQL接続URL（Drizzle ORM用） |

---

## 6. 連携サマリー

### origin-coreが提供するもの（他ツールが依存）

```
┌─────────────────────────────────────────────────────────────────┐
│                         origin-core                              │
│                                                                  │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │  Supabase（共有DB）  │    │  PostgreSQL（ローカルDB）        │ │
│  │  - departments      │    │  - products / productGroups     │ │
│  │  - members          │    │  - mallSettings                 │ │
│  │  - activity_logs ◄──┼────┼── /api/events/ingest（Webhook） │ │
│  │  - company_knowledge│    │  - llmProviders / llmModels     │ │
│  │  - tools            │    │  - supabaseProjects             │ │
│  └─────────────────────┘    │  - toolSupabaseAccess           │ │
│                              └─────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  他ツールが呼ぶAPI                                        │   │
│  │  GET /api/supabase-connections/:toolId                   │   │
│  │  GET /api/supabase-access                                │   │
│  │  GET /api/tool-ai-settings                               │   │
│  │  GET /api/llm/providers                                  │   │
│  │  POST /api/events/ingest  ← 全ツールのイベント集約       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 登録済みツール一覧（SOURCE_TOOLS定数より）

| toolId | ツール名（推定） |
|--------|-------------|
| `origin-core` | 本リポジトリ |
| `skillquest` | スキルクエスト |
| `origin-ai` | Origin AI |
| `image-factory` | 画像ファクトリー |
| `ys-staff-tool` | YSスタッフツール |
| `factory-management` | 工場管理 |
| `origintree-logi` | 物流管理 |
| `ec-data-platform` | ECデータプラットフォーム |
| `origintree-soumu-portal` | 総務ポータル |
| `lp-generator` | LPジェネレーター |
| `minpaku-tool` | 民泊ツール |
| `product-dev-tool` | 製品開発ツール |
| `ec-manager` | ECマネージャー |
| `testpilot` | テストパイロット |
| `origintree-ec-ops` | EC Ops |

### 連携パターン

| パターン | 詳細 |
|---------|------|
| **イベント集約** | 他ツールが`POST /api/events/ingest`を叩き、origin-coreのSupabase `activity_logs`にイベントを書き込む |
| **Supabase接続情報の取得** | 他ツールが`GET /api/supabase-connections/:toolId`を呼び、自分が使うべきSupabaseプロジェクトと接続情報を取得する（推定） |
| **AI設定の共有** | 他ツールが`GET /api/tool-ai-settings`や`GET /api/llm/providers`を呼び、LLMプロバイダー情報を取得する（推定） |
| **CORS自動管理** | `tools`テーブルに登録されたツールのURLが5分ごとにCORS許可リストに反映される |
| **Webhook受信** | LINE/Slack/Chatworkからのメッセージをorigin-coreが受信し、統合メッセージDBに保存 |

### 要確認事項

- `toolsテーブル`のmigrationファイルが見当たらない（要確認: 別のリポジトリで管理されているか）
- `GET /api/supabase-connections/:toolId` の実際の呼び出し元ツールの特定（各ツールのコードを確認要）
- `EXTERNAL_SUPABASE_URL` が参照する外部DBの正体（別のプロジェクトのSupabaseか）
- WeChat・Gmail Webhookのスタブ実装の完成予定
