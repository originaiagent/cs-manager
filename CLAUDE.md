# cs-manager

OriginAI マルチチャネル統合カスタマーサポート + AI改善サイクル

## Project Info
- DeployTarget: Vercel
- Core API: https://origin-core-465031496778.asia-northeast1.run.app
- AI API: https://origin-ai-five.vercel.app

## Environment Variables
- `CORE_API_URL`: Core API endpoint
- `INTERNAL_API_KEY`: Shared secret for Core API (X-Internal-API-Key)
- `ORIGIN_AI_URL`: AI API endpoint
- `ORIGIN_AI_API_KEY`: AI API key
- `ORIGIN_AI_TOOL_NAME`: cs-manager
- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key
- `RAKUTEN_SERVICE_SECRET`: 楽天 RMS Service Secret (R-MessE adapter 用)
- `RAKUTEN_LICENSE_KEY`: 楽天 RMS License Key (R-MessE adapter 用)
- `CRON_SECRET`: Vercel Cron Bearer token (`/api/cron/sync-channels` 認可)

## Development
```bash
npm install
npm run dev
```

## Diagnostics
- `/api/diag/core`: Check Core API connectivity (requires `X-Diag-Token: $DIAG_TOKEN` header)
- `/api/diag/ai`: Check AI API connectivity (requires `X-Diag-Token: $DIAG_TOKEN` header)

## Cron Jobs (Vercel)
- `/api/cron/sync-channels`: 10分間隔（`*/10 * * * *`）。active な channels を順に adapter 実行 → tickets/messages を upsert。
  - 認可: `Authorization: Bearer ${CRON_SECRET}` または手動 `X-Diag-Token: $DIAG_TOKEN`

## DB Schema (Phase 1.1)
channels / channel_credentials / tickets / messages / channel_sync_state.
全テーブル RLS 有効、service_role のみ読み書き可（Phase 1.2 で UI 用ポリシー追加予定）。

## Channel Adapters
- `src/channels/_lib/`: ChannelAdapter インターフェース・正規化型・registry
- `src/channels/rakuten/`: 楽天 R-MessE (InquiryManagementAPI) adapter
  - エンドポイント: `https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api/`
  - 認証: `ESA <base64(serviceSecret:licenseKey)>` (ec-manager パターン踏襲)

Note: spec で示された `_diag` は Next.js App Router の private folder 規約 (アンダースコアプレフィックスはルーティングから除外) と衝突するため `diag` に変更。
