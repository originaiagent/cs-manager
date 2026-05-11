# QA自動評価（Step 5.5）

push前にcodexによる品質自動評価を実行する。
verdict=pass でPR作成へ進む。verdict=fail なら減点理由を元に修正して再評価（最大3回）。

引数: $ARGUMENTS（テンプレートslug。例: api_implementation, ui_implementation, bugfix, refactoring, cross_tool_integration, builder_output）

## 前提条件
- ビルド成功済み（/verify 完了後に実行すること）
- CORE_API_URL と INTERNAL_API_KEY が環境変数に設定済み
  - CORE_API_URL が未設定の場合: `https://origin-core-1016853914778.asia-northeast1.run.app` をデフォルトとする
  - ローカル開発時は `http://localhost:5001` を使用

## 実行手順

### Step 1: テンプレート取得

```bash
CORE_API_URL="${CORE_API_URL:-https://origin-core-1016853914778.asia-northeast1.run.app}"
curl -s -H "X-Internal-API-Key: ${INTERNAL_API_KEY}" \
  "${CORE_API_URL}/api/qa/templates/$ARGUMENTS"
```

レスポンスから以下を取得:
- `template.judge_prompt` — 評価プロンプト
- `template.criteria` — 評価基準配列
- `template.pass_threshold` — 合格ライン（%）
- `template.min_item_score` — 各項目最低点

テンプレートが見つからない場合はエラーを報告して停止。

### Step 2: input_data 構築

#### 2-1. git diff取得（ノイズフィルタ済み）
```bash
git diff main --stat
git diff main -- . ':!package-lock.json' ':!dist/' ':!*.min.js' ':!*.map'
```

差分がない場合はエラーを報告して停止。

#### 2-2. テスト結果収集
プロジェクト種別に応じてビルド/テスト結果を収集:
- `npm run build 2>&1 | tail -20`（ビルド結果のサマリ）
- テストがあれば `npm test 2>&1 | tail -30`

#### 2-3. input_data を JSON に構成
```json
{
  "diff": "（git diffの内容）",
  "diff_stat": "（git diff --statの内容）",
  "build_result": "（ビルド結果）",
  "test_result": "（テスト結果、あれば）"
}
```

### Step 3: シークレットマスキング

input_data 内の以下パターンを `***` に置換:
- `sk-[A-Za-z0-9_-]{20,}` — OpenAI/Anthropic APIキー
- `shpat_[A-Za-z0-9]{30,}` — Shopify トークン
- `AKIA[A-Z0-9]{16}` — AWS アクセスキー
- `password\s*=\s*\S+` — パスワード代入
- `Bearer\s+[A-Za-z0-9._-]{20,}` — Bearer トークン
- `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` — JWT トークン

**検知時の挙動**: シークレットパターンが1つでも検知された場合:
1. マスキング後のデータで評価は続行しない
2. verdict=fail として即座にローカルFAIL
3. 検知されたパターンの種類と件数を報告
4. 「シークレットをコードから除去してから再実行してください」と指示

### Step 4: codex評価実行

#### 4-1. judge_promptにinput_dataを注入
テンプレートの `judge_prompt` 内の `{{input_data}}` をStep 2-3で構築した input_data で置換する。

#### 4-2. codex実行
```bash
echo "{置換済みjudge_prompt}" | codex exec -
```

**重要**:
- temperature=0 で実行（評価ブレ防止）。codex CLIの場合は上記コマンドのまま（CLIはデフォルトでtemperature制御）
- JSONのみの出力を期待。前後にテキストが付いた場合はJSON部分を抽出

#### 4-3. レスポンスパース
codexの出力をJSONとしてパースし、以下を取得:
- `criteria[]` — 各項目のスコア・reasoning・evidence
- `total_score` — 合計点
- `max_score` — 満点
- `verdict` — pass / fail
- `verdict_reason` — 理由

パースに失敗した場合は1回だけリトライ（codex再実行）。2回失敗でエスカレーション。

### Step 5: 合否判定

以下の条件をすべて満たす場合に verdict=pass:
1. `total_score / max_score * 100 >= pass_threshold`
2. すべての項目で `score >= min_item_score`
3. `is_gate=true` の項目（critical_issues等）で `score >= min_item_score`（未満なら即FAIL）

### Step 6: 結果記録（Core API）

```bash
curl -s -X POST "${CORE_API_URL}/api/qa/runs" \
  -H "Content-Type: application/json" \
  -H "X-Internal-API-Key: ${INTERNAL_API_KEY}" \
  -d '{
    "template_slug": "$ARGUMENTS",
    "tool_name": "（現在のリポジトリ名）",
    "branch": "（現在のブランチ名）",
    "attempt_number": （試行回数）,
    "input_summary": "（diffのstat情報）",
    "judge_prompt_snapshot": "（実際に使用したprompt全文）",
    "applied_criteria": （テンプレートのcriteria配列）,
    "verdict": "pass/fail",
    "verdict_reason": "（codexの判定理由）",
    "total_score": N,
    "max_score": N,
    "score_percentage": N,
    "judge_model": "codex",
    "judge_raw_response": "（codexの生レスポンス）",
    "results": [
      {"criteria_key": "項目名", "score": N, "max_score": N, "reasoning": "...", "evidence": "..."},
      ...
    ]
  }'
```

### Step 7: 結果に基づくアクション

#### verdict=pass の場合
```
■ QA評価結果: PASS ✅
- テンプレート: $ARGUMENTS
- スコア: {total_score}/{max_score} ({score_percentage}%)
- qa_run_id: {run.id}
- 試行回数: {attempt_number}

→ PR作成に進みます
```

#### verdict=fail の場合（attempt_number < 3）
1. Geminiの各項目のreasoning + evidence を抽出
2. 以下のフォーマットで修正指示を構築:

```
■ QA評価結果: FAIL ❌（試行 {attempt_number}/3）
- スコア: {total_score}/{max_score} ({score_percentage}%)

【前回の指摘事項】
{各項目で score < min_item_score のもの:}
- {criteria_name}: {score}/{max_score}
  理由: {reasoning}
  根拠: {evidence}

上記の指摘を修正してください。修正後、ビルド検証→/qa-eval $ARGUMENTS を再実行します。
```

3. 指摘事項を元にコードを修正
4. ビルド検証を再実行
5. attempt_number を +1 して再度 Step 1 から実行

#### verdict=fail（attempt_number >= 3）の場合
```
■ QA評価結果: 3回FAIL — エスカレーション 🚨
- テンプレート: $ARGUMENTS
- 最終スコア: {total_score}/{max_score} ({score_percentage}%)
- qa_run_id: {run.id}

【未解決の指摘】
{各項目の詳細}

トムに確認を依頼してください。
```

修正を試みず、そのまま停止する。
