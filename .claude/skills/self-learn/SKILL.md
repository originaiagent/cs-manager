---
name: self-learn
description: 学んだことを記録する時・ルールを書き換えたくなった時に必ず使う。学びの書き先決定表と肥大化防止ルール。
---

# self-learn: 学びの書き先決定表

学び・気づき・記録を書く前に、必ずこの決定表で書き先を決める。表にない場所（CLAUDE.md への行動ルール追記、README、コード内コメント等）に学びを書かない。

## 決定表

| 学びの種類 | 書き先 |
|---|---|
| コード構造・アーキテクチャの事実 | docs/architecture.md |
| 作業記録（何をしたか） | docs/progress.md |
| 教訓・失敗パターン | docs/lessons-learned.md |
| 行動ルールの変更提案 | docs/evolution-log.md に記録し tool-template への提案（各リポでの直接編集は禁止） |
| 恒久ID・不変の方針 | auto-memory |
| 進捗・バージョン・タスク状態・個別案件 | **どこにも書かない** |

補足:
- **行動ルール**（`.claude/rules/`・`.claude/rules.md`・`.claude/commands/*`・`.claude/agents/*`・`.claude/skills/*`・`.claude/settings.json`）の正本は tool-template。変更したい場合は docs/evolution-log.md に記録し、【進化提案】としてトムの承認を得て tool-template への PR で行う（手順は /evolve コマンド参照）。各ツールリポで直接編集しても dispatch-sync で上書きされる
- **auto-memory** に書くのは恒久的に変わらないもののみ（プロジェクトID、確定済みの不変方針等）。作業状態・進捗は書かない
- 迷ったら「1ヶ月後に読んで価値があるか」で判断。価値がなければ「どこにも書かない」

## 肥大化防止ルール（追記時に必ず適用）

1. **重複回避**: 追記前に既存内容を grep し、同じ内容が既にあれば追記しない
2. **更新優先**: 新規追加より既存記述の更新を優先する
3. **圧縮**: 各ファイルが100行を超えたら、古い順に要約・圧縮する（docs/progress.md にも適用）

## 委譲

記録作業は scribe エージェント（haiku）への委譲を推奨。scribe はこの決定表に従って書き込む。
