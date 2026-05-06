# [DeployTarget: Template] {TOOL_NAME}

> 共通の行動原則は `.claude/rules.md` を参照。このファイルにはプロジェクト固有の情報のみ記載する。

## ツール概要
{TOOL_DESCRIPTION}

## 技術スタック
- フレームワーク: {FRAMEWORK}
- デプロイ先: {DEPLOY_TARGET}
- DB: {DATABASE}
- 主要ライブラリ: {LIBRARIES}

## URL
- 本番(main): {PRODUCTION_URL}
- プレビュー: PRごとにVercel等が自動生成

## ディレクトリ構成
```
{DIRECTORY_STRUCTURE}
```

## Supabase接続

DB操作はSupabase MCPツール（execute_sql, apply_migration, list_tables等）を使う。

| プロジェクト | project_id | 権限 |
|---|---|---|
| {TOOL_NAME} | {SUPABASE_PROJECT_ID} | 読み書き |

## プロジェクト固有の注意事項
{PROJECT_SPECIFIC_NOTES}

## アーキテクチャ原則（B案）— 絶対ルール

### マスタデータはorigin-coreが唯一の正（Single Source of Truth）
- 商品マスタ（products, product_costs, product_mall_settings等）、ユーザー情報、商品グループ等はorigin-core DBが正
- 各ツールのローカルDBにマスタデータのコピーテーブルを作るのは禁止
- マスタデータの参照・更新は必ずCore API経由（INTERNAL_API_KEY認証）
- 唯一の例外: origin-aiのみorigin-core DB直接アクセス許可

### 各ツールのローカルDBに持つのは業務データのみ
- 例: ec-managerのsales, amazon_financial_events等（そのツール固有のデータ）
- 「ローカルDBが空 → 自動登録機能を作る」は禁止。Coreから取得するAPIを使え
- Core APIに適切なエンドポイントがない場合は、勝手に代替を作らず報告して止まれ

### 場当たり的な解決の禁止
実装する前に必ず以下を確認:
1. この変更は他のページ・機能・ツールに影響しないか
2. アーキテクチャ原則に違反していないか
3. 既存の仕組みで解決できないか（新しいテーブル/API/機能を作る前に確認）
4. 指示文の内容がこの原則に矛盾する場合は、指示に従わず報告して確認を取ること
