# 自己進化チェック

作業完了時にこのコマンドを実行し、改善できることがないか振り返る。

## 実行手順

### 1. 今回の作業を振り返る
- ハマったポイントはあったか？
- 同じ問題が過去にも発生していたか？（docs/lessons-learned.md を確認）
- もっと効率的なやり方はあったか？
- 次回同じ作業をする時に知っておくべきことはあるか？

### 2. 学びの記録（承認不要）

学びの書き先は **self-learn スキル（`.claude/skills/self-learn/SKILL.md`）の決定表**に従う。肥大化防止ルール（既存grep→重複回避 / 更新優先 / 100行超で圧縮）も同スキルに従う。記録作業は scribe エージェントへの委譲を推奨。

あわせて以下も確認:
- CLAUDE.md の事実情報（技術スタック・URL等）に変更があれば更新
- API/DB/テーブル構造を変更した場合、CLAUDE.mdの連携情報に更新漏れがないか確認（origin-coreの場合はdocs/integration-map.mdも更新）

### 3. 行動ルールの変更提案（承認フロー — これが正本）

`.claude/rules/`・`.claude/rules.md`・`.claude/commands/*`・`.claude/agents/*`・`.claude/skills/*`・`.claude/settings.json` を変えたくなった場合:

- **ルールの正本は tool-template。各ツールリポでの直接編集は禁止**（dispatch-sync で上書きされ、フリート全体と食い違うため）
- 手順:
  1. docs/evolution-log.md に提案内容を記録する
  2. 完了報告に【進化提案】を添えて**トムの承認**を得る
  3. 承認後、**tool-template への PR** として提出する（merge後 dispatch-sync で全リポへ伝播）

**提案フォーマット:**
```
【進化提案】
■ 対象ファイル: [tool-template内のパス]
■ 変更内容: [具体的に何を変えるか]
■ 理由: [なぜ必要か]
■ 影響範囲: [全リポ or このリポのみ]
```

### 4. pushに含める

docs/ の更新は今回の作業ブランチに含めてpushする。別ブランチにする必要はない。
