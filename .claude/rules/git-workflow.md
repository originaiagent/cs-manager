## Git ワークフロー（絶対ルール）
- mainブランチに直接push禁止
- 必ずfeatureブランチからPRを作成する
- `git push origin <branch-name>` のみ使用。`git push origin main` は絶対禁止
- GitHub Freeプランのためブランチ保護が効かないので、運用ルールで厳守
- push前に `git branch --show-current` で現在のブランチがmainでないことを確認せよ

## ブランチ命名規約
- ブランチ名は目的を表すプレフィックス + 簡潔な内容
  - 例: `claude/fix-deploy`, `feat/new-feature`, `fix/auth-bug`, `chore/upgrade-deps`
- Claude Code 経由で作成されたブランチは `claude/...` を使用
- 長期ブランチは `main` のみ。`develop` 等の長期ブランチは作らない
- アーカイブ用途のタグは `archive/<内容>-<YYYY-MM-DD>` 形式
