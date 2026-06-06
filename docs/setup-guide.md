# セットアップガイド（技術リファレンス）

> Claude Codeが新規ツールの初期セットアップ時に参照するドキュメント。
> コマンド /project:setup から呼び出される。

---

## 1. 必須ファイル（全デプロイ先共通）

### .github/workflows/auto-merge.yml

claude/ブランチへのpushをmainに自動マージするGitHub Actions。
以下の内容をそのまま使用すること（改変禁止）。

#### 重要な注意点
- permissions: contents: write は jobsの外側（トップレベル）に書く
- git fetch origin main が必須（ないとmainブランチの参照に失敗する）
- --no-edit を使用（--no-ffではない）

### CLAUDE.md

テンプレートは /CLAUDE.md を参照。セットアップ時にプレースホルダーを実際の値に置換する:

| プレースホルダー | 説明 |
|---|---|
| {TOOL_NAME} | ツール名（リポジトリ名と同じ） |
| {TOOL_DESCRIPTION} | ツールの概要説明 |
| {FRAMEWORK} | 使用フレームワーク |
| {LANGUAGE} | 使用言語 |
| {DEPLOY_TARGET} | Vercel / Cloud Run / Cloudflare Pages |
| {PREVIEW_URL} | PRプレビュー用の確認URL |
| {PRODUCTION_URL} | main用の本番URL |

---

## 2. デプロイ先別の初期ファイル構成

### 2-A. Vercel（Next.js）

作成するファイル:
- package.json（next, react, react-dom, typescript, @types/react, @types/node）
- next.config.js
- tsconfig.json
- app/layout.tsx（App Router）
- app/page.tsx（「{ツール名} - セットアップ完了」と表示）
- app/globals.css
- .gitignore（Node用 + .next/, out/）

URL体系:
- 確認: PRごとにVercelが自動生成するプレビューURL
- 本番: https://{ツール名}.vercel.app

### 2-B. Streamlit（Python）

作成するファイル:
- app.py（st.title + 「セットアップ完了」表示）
- requirements.txt（streamlit）
- .gitignore（Python用）

URL体系: Cloud Run デプロイ後に status.url で確定（Streamlit はフレームワーク。Cloud Run コンテナでホストし、deploy/render-service.sh 経由でデプロイ）。

### 2-C. Cloud Run（Node.js/TypeScript）

作成するファイル:
- package.json（express, typescript, ts-node, @types/express, @types/node）
- tsconfig.json
- src/index.ts（Express。ポート process.env.PORT || 8080）
- Dockerfile（Node.js 20、multi-stage build）
- cloudbuild.yaml（Cloud Buildトリガー用）
- .dockerignore
- .gitignore（Node用 + dist/）

URL体系:
- 確認: https://{ツール名}-dev-465031496778.asia-northeast1.run.app
- 本番: https://{ツール名}-465031496778.asia-northeast1.run.app

GCP: プロジェクト logistics-app-481912 / リージョン asia-northeast1

### 2-D. Cloudflare Pages（SPA）

作成するファイル:
- index.html
- style.css
- .gitignore

URL体系: Cloudflare Pagesでデプロイ後に確定。

---

## 3. セットアップ後の動作確認

1. claude/initial-setup ブランチを作成してpush
2. PRを作成し、GitHub Actionsが正常に実行されることを確認
4. 報告文を出力して止まる

---

## 4. 完了報告フォーマット

【完了報告】{ツール名} 初期セットアップ

■ 実施した作業
- [x] .github/workflows/auto-merge.yml 作成
- [x] CLAUDE.md 作成（行動原則・ブランチルール・エラー対応記載済み）
- [x] .claude/settings.json 作成
- [x] .claude/commands/ 作成（plan, implement, fix, save, status, setup, fix-conflict, check-deploy）
- [x] .claude/agents/ 作成（architect, reviewer, error-fixer, investigator, db-designer）
- [x] docs/ 作成（setup-guide, architecture, vision, preferences, lessons-learned, progress, roadmap）
- [x] 初期ファイル構成作成（{デプロイ先}用）
- [x] claude/initial-setup → PR作成・マージ確認

■ ユーザーが行う残作業（デプロイ先により異なる）

Vercel / Cloud Runの場合:
- [ ] 確認URLでの動作確認

Streamlit（Cloud Run ホスティング）の場合:
- [ ] `deploy/render-service.sh` で初回デプロイ
- [ ] エントリポイント: app.py / ブランチ: main
- [ ] 確認URLでの動作確認

Cloudflare Pagesの場合:
- [ ] Cloudflare Pagesでリポジトリを接続（https://dash.cloudflare.com）
- [ ] ビルド設定: 出力ディレクトリ /
- [ ] 確認URLでの動作確認

■ URL
- プレビュー: PRごとに自動生成
- 本番(main): {PRODUCTION_URL}

---

## 4.5 Policy Gate hook の前提（origin-policy 正本参照）

`.claude/hooks/policy_gate_stop.sh` / `report_package_validator.sh` / `question_classifier.sh` は
起動時に `origin-policy` リポジトリから検出器（yaml）と report schema を取得します。

### 必須コマンド
- `curl`（macOS / Ubuntu とも標準）
- `jq`（macOS: `brew install jq`、Ubuntu: `apt install jq`）
- yaml パーサ: `python3` + PyYAML
  - macOS: system python3 (`/usr/bin/python3`) に標準で含まれる
  - Ubuntu: `apt install python3-yaml`
  - 不在時: hook 内蔵の last-resort パターンで動作（最低限の R1/R3 検出のみ）
- (任意) `yq`（mikefarah v4） — yaml の手動デバッグに便利
  - macOS: `brew install yq`、Ubuntu: `snap install yq` / `wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/local/bin/yq && chmod +x /usr/local/bin/yq`
  - 注: hook 自体は yq を使わない（python3 + PyYAML のみで動作）

### 取得元 / キャッシュ
- live: `https://raw.githubusercontent.com/originaiagent/origin-policy/main/`
- cache: `~/.origin-policy-cache/`（5 分 TTL、fetch 失敗時 fallback）
- bundled fallback: `.claude/hooks/lib/fallback/`（cache も無い場合）

### 動作確認
```bash
bash -c '
source .claude/hooks/lib/load_detectors.sh
yaml_parser_available && echo "parser: OK" || echo "parser: NG (last-resort fallback)"
echo "tier0 yaml: $(policy_gate_yaml_path)"
echo "categories yaml: $(human_judgment_yaml_path)"
echo "report schema: $(report_package_schema_path)"
'
```

### 環境変数（任意）
- `ORIGIN_POLICY_RAW_BASE` — origin-policy raw URL ベース（ブランチ切替や fork 用）
- `ORIGIN_POLICY_CACHE_DIR` — キャッシュディレクトリ
- `ORIGIN_POLICY_CACHE_TTL_SECONDS` — TTL 秒数（既定 300）
- `ORIGIN_POLICY_CURL_TIMEOUT` — curl --max-time 秒数（既定 3）

---

## 5. トラブルシューティング

### auto-mergeが動かない
1. Settings → Actions → Workflow permissions が「Read and write」か確認
2. auto-merge.yml の permissions: contents: write がトップレベルにあるか確認
3. git fetch origin main の行があるか確認

### マージコンフリクト
1. mainの最新をpull
2. mainベースで新しい claude/fix-xxx ブランチを作成
3. 変更内容をmain上のコードに正しく適用し直す
4. 既存のclaude/ブランチは使わない

### DBスキーマ変更がある場合
- Supabase MCPの apply_migration でSQL実行（コードデプロイとは別系統）
- コード + DB両方変更: 先にDB → 後でコード
