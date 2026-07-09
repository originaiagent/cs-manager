## Git ワークフロー（絶対ルール）
- mainブランチへの直接push絶対禁止。push は `git push origin <branch-name>` のみ使用
- 必ずfeatureブランチからPRを作成する
- GitHub Freeプランのためブランチ保護が効かないので、運用ルールで厳守
- push前に `git branch --show-current` で現在のブランチがmainでないことを確認せよ

## ブランチ命名規約
- Claude Code 経由で作成されたブランチは `claude/<簡潔な内容>`（例: `claude/fix-deploy`）
- 長期ブランチは `main` のみ。`develop` 等の長期ブランチは作らない
