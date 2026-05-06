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

## Development
```bash
npm install
npm run dev
```

## Diagnostics
- `/api/_diag/core`: Check Core API connectivity
- `/api/_diag/ai`: Check AI API connectivity
