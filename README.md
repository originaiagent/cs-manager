# tool-template

> OriginAI 新規ツール用テンプレートリポジトリ。
> 新しいツールを作る時は「Use this template」から作成する。

## このリポジトリの使い方

このリポジトリを直接編集しないでください。
新しいツールを作る時は、GitHubの「Use this template」ボタンから新規リポジトリを作成します。

## 含まれるファイル

| ファイル | 役割 |
|---|---|
| CLAUDE.md | Claude Codeへの指示書（行動原則・ブランチルール・エラー対応） |
| .claude/settings.json | Claude Codeの権限設定（main push禁止等） |
| .claude/commands/ | plan, implement, fix, save, status, setup, fix-conflict, check-deploy |
| .claude/agents/ | architect, reviewer, error-fixer, investigator, db-designer |
| .github/workflows/auto-merge.yml | claude/ブランチ → main 自動マージ |
| docs/ | setup-guide, architecture, vision, preferences, lessons-learned, progress, roadmap |
| docs/auth-fetch-checker.md | 認証済みFetchチェックツールのドキュメント |
| scripts/check-auth-fetch.mjs | 認証済みFetchチェックツール本体 |
