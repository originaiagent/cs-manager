---
description: CLAUDE.mdに [DeployTarget: Vercel] と記載されている場合のみ使用。それ以外では絶対に読み込まないこと。
---

# Vercelデプロイガイド

## ローカルで通ってもVercelで落ちる原因TOP3

1. **環境変数の未設定** — Vercelダッシュボードに登録が必要
2. **Node.jsバージョンの不一致** — package.jsonのenginesで固定すること
3. **TypeScriptのstrict mode** — Vercelだけ有効になっている場合がある

## API Routes制約

- Hobby: 10秒タイムアウト / Pro: 60秒タイムアウト
- レスポンス: 4.5MB上限

## middlewareの罠

- Edge Functionとして全リージョンにデプロイされる
- 1リージョン障害で全体失敗 → matcher設定で対象パスを絞ること

## next.config.js必須設定

- `images.remotePatterns`: 外部画像を使う場合は必須
- `eslint.ignoreDuringBuilds`: false（ビルド時もESLintを実行）

## push前チェック

1. `npm run build`
2. `npx tsc --noEmit`
3. 環境変数がVercelダッシュボードに登録されているか確認
4. API Routeにタイムアウト処理があるか確認
