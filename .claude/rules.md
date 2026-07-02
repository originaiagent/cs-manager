# 共通行動原則（全リポ共通・同期対象）

> tool-template から自動同期。改善提案は docs/evolution-log.md に記録 → トム承認後に反映。
> **簡潔さ最優先**: 肝心な規律が埋もれないこと。追記は既存と統合し冗長を削る。1ルール数行。膨らむなら古い/重複セクションを整理してから足す。

## 自律境界（AIエージェントの判断範囲・2026-06-18）

原則: 判断可能なものは全部自分で決めて進める。subagent並列・bypassPermissions・トークン潤沢で爆速（Dynamic Workflows）。いちいち人間に戻さない。

**自分で決めて進める（戻さない）**
- スコープ内の実装・設計判断、リポの clone/checkout、dark/additive/可逆な変更、PR→main 自動マージ（dark/additive に限る）
- ゲートが部分的に塞がっても、原因が本タスクと無関係 or スコープ外なら → backlog 起票して先へ進む（止まらない）
- スコープ外の不具合・改善の発見 → backlog 起票のみして本筋続行
- 「止まるか / 安全で可逆な手で進むか」で迷ったら → 進む

**人間に戻す（これだけ）**
- 親ゴール / スコープの変更
- BC-break / 本番データ破壊 / ロールバック不能
- 課金発生・アカウント / 権限 / IAM 付与など人間しかできない物理作業
- go-live（本番フラグ ON＝世に出す）

## 作業フロー（全作業でこの順序に従う）

**YOU MUST follow this flow for every task. Do not skip steps.**

### Step 1: 計画（実装前に必ず）
- CLAUDE.md と docs/ でプロジェクト固有の制約を確認
- grep/Globで影響範囲を徹底調査し、全対象ファイルを洗い出してから計画
- 仕様が曖昧な場合のみユーザーに質問（技術的に自明なことは聞かない）
- DB変更がある場合はスキーマ設計を先に行う

### Step 2: ユーザー承認
- デザイン・仕様の判断が必要な場合のみ。不要なら即Step 3へ

### Step 3: 実装
- 計画に沿って実装。影響範囲の全ファイルを一緒に修正（部分最適禁止）
- 計画にない「ついで」の改善・リファクタ・ライブラリ追加は禁止

### Step 4: セルフレビュー
- 変更した名前（カラム/関数/型/コンポーネント）をgrepし修正漏れがないか確認
- 既存機能の破壊、undefined参照、非同期エラー漏れ、条件分岐漏れをチェック
- **「たぶん大丈夫」は禁止。根拠をgrepで確認しろ**

### Step 5: 動作検証

変更タイプに応じて検証方法を選択:

A) API/バックエンド変更 → curl で実際のリクエストを送り、レスポンスを確認
B) UI変更（レイアウト/表示/操作） → /browse でブラウザを開き、実際に操作して確認
   - スクロール系: 実際にスクロールして挙動を確認
   - フォーム系: 入力→送信→結果を確認
   - モーダル/ドロワー系: 開閉→操作→閉じるを確認
   - 等（変更に応じたユーザー操作を再現すること）
C) A+B 両方ある場合 → 両方やれ

「コードが正しい」≠「動く」。ブラウザで見ていない変更は未検証。
UI変更でブラウザ検証なしのpushは Step 5 違反 = push禁止。

検証後にdev serverを確実に停止。

### Step 5.5: コードレビュー（push前に必須）

**YOU MUST run Codex review before every push. No exceptions.**

codex exec "git diff --merge-base origin/main を読んで、このコード変更を日本語でレビューしてください。論理バグ、エッジケース、既存機能への影響、セキュリティ問題を指摘してください。問題なければ APPROVE と明記してください。"

→ APPROVE が出るまで修正→再レビュー。APPROVE なしの push は禁止。

**大規模アーキ変更・DBスキーマ変更時は実装前にもプランレビュー：**

codex exec --sandbox read-only "計画書を読んで、影響範囲・破壊リスク・見落としを指摘してください: $(cat docs/plan.md)"

### Step 6: push + 完了報告
- ブランチは `claude/[作業内容]` を使用
- 作業開始時に必ず `git checkout main && git pull origin main` で最新化してからブランチを切る

### 差し戻しルール
- Step 4/5で問題発見 → Step 3に戻り修正。問題がなくなるまで繰り返す
- 3回修正しても解決しない → エスカレーション（技術用語禁止、平易な表現で報告）

## サブエージェント起動ルール（Anthropic公式準拠）

**YOU MUST apply this rule for research, investigation, or multi-file refactoring tasks.**

並列起動（最大10体）の条件: 独立3領域以上の調査 / 複数ファイル並行修正 / 複数ディレクトリ探索 / 独立複数仮説の並行検証。必須: 担当範囲を重複なく明記、何を返すか指定、スコープ具体化。単一で足りるのは 1ファイル完結 / 全体俯瞰の最初の一発目 / 1領域完結。並列化条件該当時は単一タスク指示でも分担案を提示し承認後に並列実行。

## 影響範囲の調査（変更前に必須）

**YOU MUST investigate impact before making any change.** カラム/テーブル → 参照する全ファイル・RLS・ビュー・クエリ。コンポーネント → import全ページ。API → 呼出元フロント全コード。型/interface → 使用全ファイル。関数/引数 → 呼出元すべて。影響箇所は全て一緒に修正（「1箇所だけ後で」禁止）。

## 確認基準

**判断基準: 「これは方針の判断か、手段の選択か」で考えろ。手段の選択なら自分で決めて進め。**

### 選択肢提示・推奨マーク付き質問の禁止（最優先・違反 block）

実装中・完了報告・質問のいずれでも、複数案を選択肢として人間に提示することを禁止する。頭に複数案が浮かんだ時点で、最も推奨できる案を自分で採用して即実行する。

**禁止パターン**
- 「どれにしますか？ 1案 / 2案 / 3案」式の列挙
- 「1（推奨）〜 / 2〜 / 3〜」など推奨マーク付き選択肢
- 「A or B、判断ください」「推奨は X です。進めますか？」
- 「以下のオプションがあります」式の提示

**正しい動作**
- 採用案を即実行し、判断ログに1行残す：「候補 A/B/C → A 採用、理由: X（既存踏襲 / 一般値 / 他ツール整合 / 実態優先）」
- 非致命の前提ズレ（型名・プロパティ名・シグネチャの細部が指示と実態でズレ）→ 実態優先で自己修正して継続。選択肢化しない
- 致命差異（参照先テーブル/基盤の不在・構造的不整合・破壊的変更・権限不足・下記 13 カテゴリ該当）→ 自走継続せず停止する。ただし停止時も選択肢メニュー化はせず「実態: X。Y が必要。差し戻し/判断求む」と結論ファーストで報告する（13 カテゴリ該当時は `blocking_question` JSON）

**例外**: 下記「質問する時のルール」の 13 カテゴリに該当する場合のみ `blocking_question` JSON で質問してよい。13 カテゴリ以外で「推奨」を付けられる時点で自走判断は完了している。聞くな、実行しろ。

> 正本: guide_rules `R-no-recommended-choice-presentation` (severity=block, applies_to=both) / `R-no-decidable-escalation` (severity=block, applies_to=mgmt_claude) / Supabase origin-core (`fqzsxjhhdzrliuuooqic`) guides slug=`tier0-absolute-rules` ⑥13カテゴリ。検出 trigger / カテゴリ enum の実体は origin-policy/rules/{human_judgment_categories,tier0_detectors}.yaml にあり、question_classifier hook が live→cache→bundled fallback で参照する。検出パターンに該当した質問は Stop hook が exit 2 でブロックするが、bundled fallback 時は検出範囲が縮退しうる（文面の遵守が一次、hook は補助）。

### トムに聞くこと
- デザイン・UXの好み / ビジネスロジックの判断（仕様の解釈が複数ある時）
- **本番反映ゲート3条件のみ停止**: ①コスト発生 ②不可逆な本番破壊（データ削除・テーブル構造変更等）③トムのアカウント/権限操作。これ以外の本番反映（flag OFF投入・無害deploy含む）は自走で本番まで完遂する（変更内容が下記13カテゴリ・致命差異に該当する場合のみ確認基準に従う）
- 権限上できないこと（GitHub設定、GCPコンソール、デプロイ先ダッシュボード）

### 質問する時のルール（2026-04-26 追加 / Question Classifier hook が物理ブロック）

実装中に「どっち？」と聞きたくなった時:

1. それは本当に人間でないと判断できないか自問する
2. 以下 13 カテゴリに該当しないなら、自分で決めて進める（AI 即決領域）
3. 該当する場合のみ `blocking_question` JSON で質問を出す

**対象 13 カテゴリ**（正本: origin-policy/rules/human_judgment_categories.yaml）:
parent_goal_change / business_priority / external_communication / cost_commitment / ux_brand / privacy_security / permission_blocked / data_destructive / security_iam / legal_compliance / public_communication / budget_quota / hr_evaluation

**記述形式**（正本: origin-policy/schemas/report_package.schema.json#blocking_question）:
```json
{
  "blocking_question": {
    "category": "13 カテゴリのいずれか",
    "question": "ユーザーへの質問内容",
    "proposed_default": "AI が想定するデフォルト値（Tom 応答なしならこれを採用）",
    "why_blocking": "なぜブロックするか"
  }
}
```

**Stop hook が exit 2 で物理停止する条件:**
- 自由文の質問・選択肢（structured JSON なし）
- `category` が未指定、または 13 カテゴリ enum 外
- 「念のため」「保守的に」「即決すべきなら」などの保留質問は禁止

### 聞かずに自分で処理すること
- ビルドエラー、型エラー、import漏れ、画面白化、レイアウト崩壊
- コンソールエラー、API 500エラー、typo、不要なconsole.log
- docs/やlessons-learnedに記載済みの既知問題
- 環境変数の取得、ローカル起動・テスト方法の選択
- CLIの認証・ログイン、デプロイ待ち・確認、ログの取得・確認
- ライブラリ・ツールのインストール
- 「ファイルが見つからない」→ Glob/Grep/findで探せ。人間に聞くな
- ブラウザ操作が必要 → /qa や /browse で自分でやれ。人間にスクショを頼むな
- **バグ発見時**: 明確なバグは起票・号令を待たず自走で即修正し、完遂報告に集約する（発見ごとに止まらない）。本筋外で軽微・再現不明なものは放置（報告不要）。本筋外の大型独立作業のみ「別タスク化推奨」を1回だけ挙げる

## エラー解決の原則

- 根本原因を特定してから修正。「たぶんこれが原因」で手を動かすな
- ログ・エラーメッセージ・コードの流れを追い、原因を1行で断言できてから着手
- 5分調査して断言できなければ、調査結果をユーザーに報告し判断を仰げ
- 同じパターンが他にないかgrepで探し、見つけたら同時に修正
- 修正後、docs/lessons-learned.mdに根本原因と対策を1行で追記
- `as any`、空catch、`// TODO: fix later`、条件分岐での回避は禁止
- 必要なツール/CLIが未導入なら自分でインストール。権限不可なら導入手順を提示

## デバッグ原則（根本原因の特定手順）

**最大の失敗パターン: コードだけ読んで原因を推測し修正報告するが実際には直っていない。**

1. **ログを最初に見ろ** — コードを読む前にランタイムログ。答えが書いてある確率9割。
2. **環境要因を最初に疑え** — APIキー有効性・残高、環境変数漏れ、デプロイ反映、タイムアウト、外部APIレートリミット。
3. **DB実データで裏を取れ** — 「書き込まれるはず」→ Supabase MCPで実際にSELECT。
4. **二分探索デバッグで原因を絞れ（最重要）** — パイプライン全体を把握 → 真ん中にログ → 範囲を半分に絞り繰り返す。推測でコード書くな。
5. **「直しました」チェックリスト** — ランタイムログでエラー消えた？ DB実データで正しい値？ UIはブラウザ目視（curlの200は不可）？ 未確認項目は「未確認（理由）」と明記。

## コンテキスト管理

- 1セッション1タスク。終わったら/compactしてから次へ
- 3ファイル以上変更するタスクは必ずplannerエージェントで計画を立ててから実装
- 大きな調査はサブエージェントに委任し、メインコンテキストを保護する
- 2回修正して直らない → /rescueコマンドで再スタート
- 機能実装は縦スライス方式（DB→API→UIを一気通貫）。水平スライス禁止
- 共有テーブル/APIの変更前にCLAUDE.mdの連携情報と docs/origin-integration-map.md を確認
- API/DB/テーブル構造の変更 → integration-map.md または CLAUDE.md を更新してからpush

## 自己進化

自由に更新（承認不要）: docs/、CLAUDE.mdの事実情報。提案→承認後: rules.md, commands/*, agents/*, settings.json。改善したら docs/evolution-log.md に記録。

## データベース操作

- DB操作はSupabase MCPツール（execute_sql, apply_migration, list_tables等）を使う
- DATABASE_URLへの直接接続やマイグレーション埋め込みは禁止
- 対象プロジェクトIDはCLAUDE.mdの「Supabase接続」を参照。なければユーザーに確認（推測禁止）

## origin-ai async 窓口を呼ぶフロント（共通待機部品 必須）

origin-ai の async スキル（execution_mode=async）は worker が 300s〜1700s 走る。これを呼ぶ
**フロントが worker 完走を待ちきれず「失敗」表示する穴**を各ツールで個別に踏まないため、待ち方は
origin-ai 提供の共通部品に一本化する（AI処理は origin-ai 集約・ツールは入口だけ、の待機版）。

- async 窓口（`/api/embed/run` → poll `/api/embed/runs/{id}`）を呼ぶフロントは、
  **共通待機部品 `src/lib/origin-async-wait`（SoT=origin-ai dashboard/lib/async-wait）を使う**。
  `waitForAsyncRun(makeEmbedRunPoller(statusUrl))` で待つ。**poll ループ・最大待機秒・deadline を自作しない。**
  ※ 部品は **async を採用したリポにのみ adopt-on-need で vendor 配布**される（dispatch-sync の
  `ASYNC_WAIT_TARGETS` allowlist）。本リポにファイルが無い場合は async 未採用＝この規約は休眠中。
  async を採用する際に allowlist へ追記して配布を解禁する（窓口の呼び方は origin-ai
  `docs/async-common-window-recipe.md`）。
- 最大待機は worker dispatch 枠に追従する単一ソース `ASYNC_POLL_DEADLINE_MS` を使う（**秒数を直書きしない**）。
- 規約: running/queued 中は失敗に倒さない / 端末スリープ・通信瞬断から run_id 保持で復帰 / deadline 直前に
  最終 poll / completed のみ描画・worker failed の時だけ失敗 / running 超過で再 start しない。
- `src/lib/origin-async-wait/*` は **vendored（自動配布・provenance ヘッダ付き）。直接編集禁止**（dispatch-sync で上書き）。
- 詳細: origin-ai `docs/async-front-wait-common-design.md` / `docs/skill-design-v3.md §2.1`。

## デプロイ運用

- デプロイはmainブランチ上でのみ実行。フィーチャーブランチからの直デプロイ禁止
- 手順: Codexレビュー（Step 5.5）→ push → PR → マージ → mainでデプロイ

## 本番E2E実施必須化ルール（merge前ゲート）

**ローカルテスト + Codexレビュー通過 ≠ 本番で動く保証。** 該当PRは merge 前に本番URLでのE2E必須。スキップ禁止。

**対象PR**（いずれか該当でE2E必須）: 複数リソース横断作成/更新API / atomic性が必要なトランザクション境界変更（partial-create を起こし得る経路）/ UI操作からDB反映までの一連フロー変更（複数テーブル）/ LLM出力をDBに永続化する経路（builder, factory 等）。

**対象外**: 文言・スタイルのみ / 単一カラムの軽微変更 / ドキュメント / テスト追加のみ。迷ったら対象とみなしてE2E実施。

**コードレビュー時の前提**: 対象PRは Codex レビュー時点で DBトランザクション（atomic操作）の正当性を最優先で確認。E2Eは最終ゲートで、コードレベルで atomic性が崩れていれば本来そこで弾く。両方クリアで初めて merge可。

**E2E実施内容（4項目すべて）**:
1. **本番相当環境**（① Staging専用DB > ② 本番DB接続Preview/本番のテスト用テナント）で実データを **UI経由** で操作。curl/script単体・モックDBのPreview単体は不可。
2. DB実態を SQL（Supabase MCP `execute_sql`）で直接確認し、全リソースが期待通り作成/更新されたことを検証。
3. ロールバック動作確認。違反データ投入→パーシャル残骸ゼロを確認。検証データは識別フラグ（`is_e2e_test=true` 等）を付与し直後にクリーンアップ必須。実エラー注入が危険なら疑似障害での挙動確認可（完了報告に明記）。
4. 結果（SQL出力/スクショ）を完了報告に **生出力のまま** Markdownコードブロックで貼付（推測サマリ禁止）。

エビデンス未記載・`未確認` 表記の完了報告は差し戻し。

**背景（incident-log）**: 2026-04-29 / origin-ai builderモード PR #137/#138 がローカルテスト + コードレビュー通過後に本番で partial-create 発生 / 根本原因: merge 前に本番URLでのフルE2E未実施 / 再発防止: 本ルールを tool-template に永続化、全ツール配布。

## 完了報告

```
【完了報告】
■ 実施した作業
■ 自己検証: ビルド✅or❌ / 回帰✅or❌（確認ページ列挙）/ エラー✅or❌
  動作確認: 検証ツール（curl / /browse / /qa）/ 操作内容 / 生エビデンス【必須・推測作文禁止】 / 観察結果
■ ※ UI変更で「生エビデンス」空欄は無効。Step 5に戻れ。
■ 本番E2E結果（対象PRのみ。非該当は「対象外」）: URL / UI操作内容 / DB SQL生エビデンス / ロールバック検証 / クリーンアップ✅or❌
■ トムの確認が必要な項目（なければ「なし」）/ 確認URL
■ incident-log（バグ修正時のみ必須・未記載なら差し戻し）:
  発生日 / 事象 / 根本原因 / 対処 / 再発防止
```

<!-- sync-trigger: 2026-05-11 -->
