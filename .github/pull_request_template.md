<!--
本テンプレートは tool-template から dispatch-sync で配布されます。
Core Master SDK 後方互換ルール: guides slug=core-master-sdk-bc-rules
-->

## 概要 / Summary

<!-- この PR で何をなぜ変えるか 1〜3 行 -->

## 動作確認 / Test plan

<!-- ビルド成功 = 完了ではない。CLAUDE.md「完了前の動作確認」参照 -->

- [ ] 単体テスト
- [ ] 動作確認（curl / dev server / E2E のいずれか実施）
- [ ] 関連ツール側で regression なし

## 後方互換チェック（Core Master SDK / DB スキーマ）

詳細ルール: guides slug=`core-master-sdk-bc-rules`

### 非破壊的変更（§2、承認不要）

- [ ] DB: nullable column 追加 / DEFAULT 付き column 追加 / enum 値追加 / 新規テーブルのみ
- [ ] SDK: 新規 resource / メソッド / optional パラメータ / optional な戻り値 field 追加のみ
- [ ] SDK consumer 側は unknown field passthrough を維持（`extra='forbid'` 等の strict validation を新規追加していない）

### 破壊的変更（§3、トム承認 ID 必須）

- [ ] **該当なし**
- [ ] 該当あり → 以下を全て満たす:
  - [ ] PR タイトルに `[BC-BREAK]` プレフィクス
  - [ ] トム承認 ID: `dev_backlog/<uuid>`
  - [ ] 影響ツール一覧と追従 PR リンク:
    - `<tool>`: PR #
  - [ ] ロールバック手順を本 description に記載

破壊的変更の例（DB: 型変更 / rename / NOT NULL 追加 / DEFAULT 削除 / enum 値削除 / 制約強化、SDK: メソッド rename・削除 / 必須パラメータ追加 / 戻り値型 strict 化 等）。判定が曖昧な場合は破壊的扱い。

### W-B4 CI チェック（実装後に有効化）

- [ ] `bc-check` ステータスが green
