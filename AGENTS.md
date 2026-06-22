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
- `CS_MCP_KNOWLEDGE_TOKEN`: MCP `knowledge_search` ツール専用の静的 Bearer トークン。origin-ai の
  `customer-reply-writer` agent がナレッジ検索時に注入する。**go-live: cs-manager と origin-ai に
  同一値を設定すること。** 未設定時は Core credential `cs_mcp_knowledge.token` にフォールバック。
  `INTERNAL_API_KEY` / `origin_ai_internal` とは別物 (流用禁止)。log 出力禁止。

外部サービス認証 (楽天 R-MessE 等) は cs-manager 内に持たない。
Core `/api/credentials/:service_code?scope_key=<店舗ID>` 経由で動的取得 (5 分 TTL キャッシュ)。

## MCP 窓口 (`/api/mcp`)
- read-only 窓口 (JSON-RPC 2.0)。`initialize` / `tools/list` は匿名。
- `tools/call`:
  - `list` / `read` / `write`: run-scoped JWT 必須 (embed 波及)。
  - `knowledge_search`: **専用静的キー (`CS_MCP_KNOWLEDGE_TOKEN`) のみ**。JWT は使えない。
    - 方式A: origin-ai `customer-reply-writer` agent が自前でナレッジ検索するための read tool。
    - args: `{query (必須), limit? (1-8)}`。db_target='cs' / pii_state='masked' /
      filter_visibility=['public','internal'] / status='published' は**サーバ固定** (args 無視)。
    - 戻り: `{results:[{title, content, article_id, chunk_id}], count}` (全て masked)。
    - 静的キーは `knowledge_search` 以外 (list/read/write) には到達不可。

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
channels / tickets / messages / channel_sync_state / ticket_drafts.
全テーブル RLS 有効、service_role のみ読み書き可（Phase 1.2 で UI 用ポリシー追加予定）。
`channel_credentials` は廃止 (Core /api/credentials 経由に移行済)。

## Channel Adapters
- `src/channels/_lib/`: ChannelAdapter インターフェース・正規化型・registry
- `src/channels/rakuten/`: 楽天 R-MessE (InquiryManagementAPI) adapter
  - エンドポイント: `https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api/`
  - 認証: `ESA <base64(serviceSecret:licenseKey)>` を Core `/api/credentials/rakuten_rmesse?scope_key=<店舗ID>` 取得結果から構築
  - 受信 (fetchInbox): `src/channels/rakuten/adapter.ts`
  - 送信 (sendApprovedDrafts): `src/channels/rakuten/outbound.ts`
  - **店舗 ID** は `channels.config.shop_id` に格納する運用 (Core API の scope_key と同一)

Note: spec で示された `_diag` は Next.js App Router の private folder 規約 (アンダースコアプレフィックスはルーティングから除外) と衝突するため `diag` に変更。
