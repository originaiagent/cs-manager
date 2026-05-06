# /project:fix-conflict コマンド

auto-mergeがマージコンフリクトで失敗した時の修復手順。

## 実行手順

1. mainブランチの最新をpull
git checkout main && git pull origin main

2. mainをベースにして新しいブランチを作成
git checkout -b claude/fix-conflict-$(date +%Y%m%d%H%M)

3. 直前の作業で変更したかった内容を、main上のコードに対して正しく適用し直す

4. コンフリクトが起きないことを確認してからpush

## 禁止事項

- 既存の claude/ ブランチを再利用しない
- git merge で無理やり解決しない
- --force push は絶対にしない

## 完了後

報告文を出力して止まる。ユーザーにGitHub Actionsタブでワークフローが緑になったことを確認してもらう。
