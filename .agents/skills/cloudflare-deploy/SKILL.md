---
description: AGENTS.mdに [DeployTarget: Cloudflare] と記載されている場合のみ使用。それ以外では絶対に読み込まないこと。
---

# Cloudflareデプロイガイド

## SPAルーティング

- `_redirects`ファイルで `/* → /index.html` を設定

## Functions制限

- CPU: Free 10ms / Paid 50ms

## キャッシュ

- デフォルトで強力にキャッシュされる
- 更新が反映されない場合はキャッシュパージを実行

## push前チェック

1. `index.html`のパス確認
2. `_redirects`ファイルの存在確認
3. CORS設定の確認
