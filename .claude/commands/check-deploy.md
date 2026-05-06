# /project:check-deploy コマンド

デプロイ状況を確認して報告する。

## 実行手順

1. 現在のブランチとコミット状況を確認
git log --oneline -5
git status

2. GitHub Actionsの結果を確認するようユーザーに案内

GitHub Actionsの状況を確認してください:
https://github.com/originaiagent/{リポジトリ名}/actions

- 緑（✓）→ mainへのマージ成功。デプロイ先を確認してください
- 赤（✗）→ 失敗ログを貼ってください。対処法を案内します
- 実行なし → 新しいclaude/ブランチでpushが必要かもしれません

3. 確認URLを案内（CLAUDE.mdに記載されたURLを使用）

## よくある問題と対処

| 症状 | 原因 | 対処 |
|---|---|---|
| Actionsが実行されない | 同じブランチの再push | 新しいclaude/ブランチを作る |
| Actionsが赤 | コンフリクト | /project:fix-conflict を実行 |
| Actionsが緑だがデプロイされない | デプロイ先の設定問題 | ユーザーにデプロイ先ダッシュボードの確認を依頼 |
| Cloud Buildが失敗 | Dockerfile問題 | エラーログを確認して修正 |
