---
description: エラー/バグの修正。builderエージェント + debug-strategyスキルで原因特定と修正を行う
context: fork
model: sonnet
---

以下のエラー/バグを修正してください。

問題: $ARGUMENTS

手順:
1. debug-strategy スキルの戦略に従って原因を特定する（仮説を3つ立て、可能性の高い順に検証）
2. 根本原因が特定できたら、builder エージェントに修正を委任
3. 修正後、reviewer エージェントでレビュー
4. 全チェック通過後、git commit → push
5. 非エンジニア向けに報告（何が壊れていたか、どう直したか、今は正常か）
6. 2回修正しても解決しない場合は /rescue コマンドに切り替えてください
