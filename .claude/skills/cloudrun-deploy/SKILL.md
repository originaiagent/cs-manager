---
description: CLAUDE.mdに [DeployTarget: CloudRun] と記載されている場合のみ使用。それ以外では絶対に読み込まないこと。
---

# Cloud Runデプロイガイド

## ポート設定

- `process.env.PORT || 8080`（固定値禁止）

## コールドスタート

- 初回10〜30秒かかる
- ヘルスチェック `/health` エンドポイント必須

## メモリ制限

- デフォルト512MB
- OOM時のエラー: 「memory limit exceeded」

## Dockerfile

- COPYパスを確認すること
- `.dockerignore`に`node_modules/`を含めること

## cloudbuild.yaml

- substitutions変数は`${_VARIABLE}`（アンダースコア必須）
- デフォルトタイムアウト10分

## GCP認証

- サービスアカウント: `claude-code@logistics-app-481912.iam.gserviceaccount.com`
- Web版は毎セッションでキー貼り直しが必要
