# /project:setup コマンド

新規ツールの初期セットアップを実行する。

## 実行条件

- mainブランチから作業ブランチを作成していること
- リポジトリが originaiagent 配下であること

## 実行手順

### 1. ユーザーに確認する（必ず最初に聞く）

以下を確認してから作業開始:
- ツール名（リポジトリ名と一致しているか）
- デプロイ先（Vercel / Streamlit / Cloud Run / Cloudflare Pages）
- ツールの概要（何をするツールか）
- メインSupabase project ID（DBを使う場合）

### 2. docs/setup-guide.md を読む

`docs/setup-guide.md` を参照して、デプロイ先に応じた正しいファイル構成を確認する。

### 3. ファイルを作成する（以下の順番で）

1. `.github/workflows/auto-merge.yml` — setup-guide.md の内容をそのまま使用（改変禁止）
2. `.claude/settings.json` — setup-guide.md の内容をそのまま使用
3. `CLAUDE.md` — テンプレートのプレースホルダーを実際の値に置換
   - Supabase project IDが入力された場合 → `{SUPABASE_PROJECT_ID}` を入力値に置換し、Supabase接続セクションを有効化
   - Supabase project IDが未入力・不明の場合 → Supabase接続セクションをコメントで残し、完了報告に「後でCLAUDE.mdにSupabase project IDを追記してください」を含める
4. `docs/architecture.md` — ツールの技術仕様
5. デプロイ先別の初期ファイル構成 — setup-guide.md のセクション2を参照

### 4. デプロイ先の自動接続

ファイル作成後、デプロイ先に応じて自動接続を実行する。

**セキュリティルール（全デプロイ先共通）:**
- トークン・キーはファイルや.envにコミットしない
- セッション内の変数としてのみ使用し、完了後に出力に含めない
- キーファイルを作成した場合は作業後に必ず削除する

#### Vercelの場合
1. ユーザーに「VERCEL_TOKENを貼ってください」と聞く
2. ユーザーに「VERCEL_ORG_ID（Team ID）を貼ってください」と聞く
   - デフォルト値: `team_Rx21MK556uog3F7MsZYlXFf9`（入力なしならこれを使用）
3. 受け取ったトークンで以下を実行:
   ```bash
   npm i -g vercel
   vercel link --yes --project={ツール名} --token=$VERCEL_TOKEN --scope=$VERCEL_ORG_ID
   vercel git connect --yes --token=$VERCEL_TOKEN
   ```
4. Vercel側でPRプレビューが有効になっていることを確認
5. 接続完了後、確認URLにcurlでアクセスしてレスポンスを確認
6. トークンを含む変数をunsetし、出力に含めない

#### Cloud Runの場合
1. ユーザーに「GCPサービスアカウントキーJSON」を貼ってもらうか確認
2. `gcloud` CLIがインストールされていることを確認（なければインストール）
3. 一時ファイルに書き出して認証:
   ```bash
   # 一時キーファイルで認証（パスは /tmp を使用）
   echo "$GCP_SA_KEY" > /tmp/gcp-sa-key.json
   gcloud auth activate-service-account --key-file=/tmp/gcp-sa-key.json
   gcloud config set project logistics-app-481912
   ```
4. Cloud Buildトリガーを作成:
   ```bash
   # 本番用（mainブランチ）
   gcloud builds triggers create github \
     --repo-name={ツール名} \
     --repo-owner=originaiagent \
     --branch-pattern="^main$" \
     --build-config=cloudbuild.yaml \
     --project=logistics-app-481912 \
     --region=asia-northeast1 \
     --substitutions=_SERVICE_NAME={ツール名},_REGION=asia-northeast1

   # PRプレビューはPRトリガーで対応（必要に応じて追加）
   ```
5. 初期ファイルに `cloudbuild.yaml` を追加（setup-guide.md セクション2-C参照）
6. 作業完了後、キーファイルを削除:
   ```bash
   rm -f /tmp/gcp-sa-key.json
   gcloud auth revoke --quiet
   ```

#### Streamlitの場合
自動接続は不可。完了報告の「ユーザーが行う残作業」に以下を記載:
- [ ] Streamlit Cloudでリポジトリを接続（https://share.streamlit.io）
- [ ] メインファイルパス: app.py / ブランチ: main

#### Cloudflare Pagesの場合
自動接続は不可。完了報告の「ユーザーが行う残作業」に以下を記載:
- [ ] Cloudflare Pagesでリポジトリを接続（https://dash.cloudflare.com）
- [ ] ビルド設定: 出力ディレクトリ /

### 5. 動作確認

1. `claude/initial-setup` ブランチを作成
2. 全ファイルをcommit & push
3. PRを作成し、GitHub Actionsが正常に実行されることを確認

### 6. 報告して止まる

setup-guide.md セクション4の完了報告フォーマットに従って報告し、必ず止まる。
ユーザーの承認なしに次の作業へ進まない。

### 同期設定（新規リポ作成時に必ず実施）

新しいリポジトリを作成した場合、tool-templateの同期対象に追加する必要がある。
完了報告の「ユーザーが行う残作業」に以下を必ず含めること:

```
- [ ] tool-templateの `.github/workflows/dispatch-sync.yml` にリポ名を追加
      → Claude Codeでtool-templateを開いて「dispatch-sync.ymlのmatrix.repoに {リポ名} を追加して」と指示
```
