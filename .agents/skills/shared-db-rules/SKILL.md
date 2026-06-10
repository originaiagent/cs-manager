---
description: DB変更時のみ使用。共有テーブル（origin-integration-map.mdに記載）の変更手順。
---

# 共有テーブル変更ルール

## 基本原則

- 共有テーブルの変更は「追加（ADD）」のみ許可
- DROP / RENAME / 型変更は絶対禁止（他ツールが即死する）

## 変更手順

1. 変更前にimpact-checkerエージェントで影響調査を実行
2. 影響調査結果が🟢または🟡の場合のみ変更を進める
3. 🔴の場合はトムに確認を取るまで変更禁止
4. 変更後にAGENTS.mdの連携情報を更新

## 命名規則

- カラム名・テーブル名: snake_case
- テーブル名は複数形（例: users, orders, products）
- 外部キーは `{テーブル名単数}_id`（例: user_id, order_id）

## マイグレーション実行

- マイグレーションはSupabase MCPツール（apply_migration）で実行
- 直接SQL実行は禁止（履歴が残らないため）
