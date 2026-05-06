# Origin Core 連携マップ
> このファイルはtool-templateから全リポに自動同期される読み取り専用ドキュメントです。
> 原本は origin-core/docs/integration-map.md です。
> 編集はorigin-core側で行い、tool-templateにコピーしてください。


# Origin Core 連携マップ

> 調査日: 2026-03-26
> 調査対象: server/routes.ts, shared/schema.ts, shared/types/database.ts, supabase/migrations/, server/corsOrigins.ts, .env.example

---

## 1. APIエンドポイント一覧

### ヘルス・ステータス

| パス | メソッド | 概要 | 他ツールから呼ばれるか |
|------|--------|------|------------------|
| `/api/health` | GET | サーバー稼働確認 | 要確認 |
| `/api/tools/health-check` | POST | 全ツールのヘルスチェック実行 | 不明 |

### Supabaseプロジェクト管理（他ツール連携の核心）

| パス | メソッド | 概要 | 他ツールから呼ばれるか |
|------|--------|------|------------------|
| `/api/supabase-connections/:toolId` | GET | 指定ツールのSupabase接続情報取得 | **はい** |
| `/api/supabase-projects` | GET/POST | プロジェクト一覧・登録 | 要確認 |
| `/api/supabase-access` | GET/POST | アクセス権マッピング管理 | **他ツールが参照する可能性あり** |

### イベント受信（外部ツールからのWebhook）

| パス | メソッド | 概要 | 他ツールから呼ばれるか |
|------|--------|------|------------------|
| `/api/events/ingest` | POST | 外部ツールからイベント受信 | **はい（x-webhook-secret認証）** |

### AI・LLM設定

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/tool-ai-settings` | GET/POST | ツール別AI設定 |
| `/api/llm/providers` | GET/POST | LLMプロバイダー管理 |
| `/api/llm/models-list` | GET/POST | モデルリスト管理 |
| `/api/llm/task-defaults` | GET | タスクデフォルトモデル一覧 |

### v2 API（正規化スキーマ）

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/v2/product-groups` | GET/POST | 製品グループ管理 |
| `/api/v2/products` | GET/POST | 製品管理 |
| `/api/v2/products/:id/costs` | GET | 製品コスト |
| `/api/v2/products/:id/mall-ids` | GET | モールID |
| `/api/v2/products/:id/profitability` | GET | 収益性 |

### 製品管理（レガシー）

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/products` | GET/POST | 製品一覧・作成 |
| `/api/products/:id` | GET/PUT/DELETE | 製品取得・更新・削除 |
| `/api/product-groups` | GET | グループ一覧 |

### モール連携

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/mall-settings` | GET/POST | モール設定管理 |
| `/api/yahoo/*` | GET/POST | Yahoo連携 |
| `/api/rakuten/*` | GET/POST | 楽天連携 |
| `/api/aupay/*` | GET/POST | auPay連携 |
| `/api/qoo10/*` | GET/POST | Qoo10連携 |
| `/api/shopify/*` | GET/POST | Shopify連携 |

### メッセージHub

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/messages/webhook/line` | POST | LINE Webhook |
| `/api/messages/webhook/slack` | POST | Slack Webhook |
| `/api/messages/webhook/chatwork` | POST | Chatwork Webhook |
| `/api/messages/reply` | POST | メッセージ返信 |

### その他

| パス | メソッド | 概要 |
|------|--------|------|
| `/api/ai/*` | POST | AI機能（ディープリサーチ、色名提案等） |
| `/api/assistant/*` | GET/POST | AIアシスタント |
| `/api/tasks/*` | GET/POST | タスク管理 |
| `/api/spreadsheet/*` | GET/POST | スプレッドシート連携 |

---

## 2. Supabaseテーブル一覧

| テーブル名 | 概要 | 他ツールと共有 |
|-----------|------|-------------|
| `departments` | 組織部署の階層構造 | **はい** |
| `members` | ユーザー情報（auth.usersと紐付け） | **はい** |
| `activity_logs` | 全ツールからのイベントログ | **はい（/api/events/ingest経由）** |
| `company_knowledge` | 全社ナレッジDB（ベクトル埋め込み） | **はい** |
| `tools` | ツールレジストリ（URL、ヘルスチェック等） | **はい（CORS自動管理）** |
| `invitations` | メンバー招待管理 | 要確認 |

---

## 3. PostgreSQLテーブル一覧（Drizzle ORM）

| テーブル名 | 概要 |
|-----------|------|
| `products` / `productGroups` | 製品マスタ（レガシー） |
| `productsNew` | 製品テーブル（v2、正規化移行中） |
| `productSkus` / `productHistory` | SKU・変更履歴 |
| `mallSettings` | EC各モールのFTP/API認証情報 |
| `llmProviders` / `llmModels` | LLMプロバイダー・モデル定義 |
| `llmTaskDefaults` | タスクタイプ別デフォルトモデル |
| `toolAiSettings` | ツール別AIモデル設定 |
| `supabaseProjects` | 外部Supabaseプロジェクト定義 |
| `toolSupabaseAccess` | ツール→Supabaseアクセス権マッピング |
| `brands` / `developers` | ブランド・開発者管理 |

---

## 4. 外部連携

### イベント受信

| エンドポイント | 認証方式 | 概要 |
|-------------|--------|------|
| `POST /api/events/ingest` | `x-webhook-secret` | 他ツールがactivity_logsにイベントを書き込む |

### 他ツールから呼ばれるAPI

| エンドポイント | 用途 |
|-------------|------|
| `GET /api/supabase-connections/:toolId` | ツールのSupabase接続情報取得 |
| `GET /api/tool-ai-settings` | ツール別AI設定取得 |
| `GET /api/llm/providers` | LLMプロバイダー一覧取得 |

### CORS設定

環境変数`ALLOWED_ORIGINS` + Supabase `tools`テーブルのURL + localhost。5分ごとにDB再読込。

---

## 5. 環境変数一覧

| 変数名 | 用途 |
|-------|------|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | フロントエンド用Supabase |
| `CORE_SUPABASE_URL` / `CORE_SUPABASE_SERVICE_KEY` | サーバーサイドSupabase |
| `EXTERNAL_SUPABASE_URL` / `EXTERNAL_SUPABASE_ANON_KEY` | 外部DB |
| `ORIGIN_SUPABASE_URL` / `ORIGIN_SUPABASE_SERVICE_KEY` | イベントインジェスト用 |
| `ALLOWED_ORIGINS` | CORS許可オリジン |
| `WEBHOOK_SECRET` | イベントインジェスト認証 |
| `DATABASE_URL` | PostgreSQL接続URL |

---

## 6. 連携サマリー

### 登録済みツール（15ツール）

origin-core, skillquest, origin-ai, image-factory, ys-staff-tool, factory-management, origintree-logi, ec-data-platform, origintree-soumu-portal, lp-generator, minpaku-tool, product-dev-tool, rakuten-insights, testpilot, origintree-ec-ops

### 連携パターン

| パターン | 詳細 |
|---------|------|
| **イベント集約** | 他ツール → `POST /api/events/ingest` → activity_logs |
| **Supabase接続** | 他ツール → `GET /api/supabase-connections/:toolId` → 接続情報取得 |
| **AI設定共有** | 他ツール → `GET /api/tool-ai-settings` → LLM設定取得 |
| **CORS自動管理** | toolsテーブルのURL → 5分ごとにCORS許可リスト更新 |
