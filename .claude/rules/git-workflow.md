## Git ワークフロー（絶対ルール）
- mainブランチに直接push禁止
- 必ずfeatureブランチからPRを作成する
- `git push origin <branch-name>` のみ使用。`git push origin main` は絶対禁止
- GitHub Freeプランのためブランチ保護が効かないので、運用ルールで厳守
- push前に `git branch --show-current` で現在のブランチがmainでないことを確認せよ
