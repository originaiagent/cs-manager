---
description: AGENTS.mdに [DeployTarget: Streamlit] と記載されている場合のみ使用。それ以外では絶対に読み込まないこと。
---

# Streamlitデプロイガイド

## requirements.txt

- バージョン固定必須
- NG: `streamlit`
- OK: `streamlit==1.32.0`

## Pythonバージョン

- デフォルト3.11
- 変更する場合は`runtime.txt`に記載

## secrets管理

- `.streamlit/secrets.toml`はgitに入れない
- ダッシュボードのSecretsに登録すること

## よくあるエラー

- `ModuleNotFoundError` → requirements.txtへの追加忘れ
- 日本語フォント表示崩れ → matplotlib設定が必要

## push前チェック

1. `pip install -r requirements.txt`
2. `streamlit run`で起動確認
3. バージョン固定されているか確認
