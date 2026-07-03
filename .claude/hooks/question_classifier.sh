#!/bin/bash
# Question Classifier — Claude Code の質問を JSON object 化強制
# 自由文質問は exit 2 で停止、AI 即決誘導
# 正本: origin-policy/rules/human_judgment_categories.yaml (13 categories)
# 正本: origin-policy/rules/tier0_detectors.yaml (r1_question_detection.trigger_patterns)
# enum / triggers は load_detectors.sh 経由で正本から取得（live → cache → bundled fallback）

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$HOOK_DIR/lib/gate_common.sh" ]; then exit 0; fi
# shellcheck source=lib/gate_common.sh
source "$HOOK_DIR/lib/gate_common.sh"

INPUT=$(cat)
gc_exit_if_stop_active "$INPUT"   # 再入ガード（parser 不在でも grep で先に評価）
# ここから transcript 解析が必要 → jq/node どちらも無ければ fail-closed（9周目P2-A）
gc_require_json_parser

TRANSCRIPT=$(gc_input_field "$INPUT" transcript_path)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi

LAST=$(gc_last_assistant_message "$TRANSCRIPT")

if [ -z "$LAST" ] || [ "$LAST" = "null" ]; then exit 0; fi

# trigger 検出は「実際に質問している本文」のみ対象。
# コードブロック内、インラインコード `...`、日本語「...」引用、行内 '...' / "..." 引用、
# ASCII シングルクォート / ダブルクォートは除外（テスト名やルール説明での誤検知防止）。
DETECT_BODY=$(printf '%s\n' "$LAST" \
  | awk 'BEGIN{c=0} /^```/{c=1-c; next} !c{print}' \
  | sed -E 's/`[^`]*`//g' \
  | sed -E 's/「[^」]*」//g' \
  | sed -E "s/'[^']*'//g" \
  | sed -E 's/"[^"]*"//g')

# ============================================================================
# 正本（tier0_detectors.yaml / human_judgment_categories.yaml）から trigger と enum 取得
# ============================================================================
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${HOOK_DIR}/lib/load_detectors.sh"

QUESTION_TRIGGERS_REGEX=()
VALID_CATEGORIES_LIST=()
LOADED=0

if [ -f "$LIB" ]; then
  # shellcheck source=lib/load_detectors.sh
  source "$LIB"
  if yaml_parser_available; then
    DETECTORS_YAML=$(policy_gate_yaml_path 2>/dev/null)
    CATEGORIES_YAML=$(human_judgment_yaml_path 2>/dev/null)

    if [ -n "$DETECTORS_YAML" ] && [ -f "$DETECTORS_YAML" ]; then
      # explicit_question / choice_offer / confirmation_request の regex を抽出
      while IFS= read -r line; do
        [ -n "$line" ] && QUESTION_TRIGGERS_REGEX+=("$line")
      done < <(yaml_eval_python "$DETECTORS_YAML" "[p['regex'] for p in d.get('r1_question_detection',{}).get('trigger_patterns',[]) if p.get('type') in ('explicit_question','choice_offer','confirmation_request')]")
    fi

    if [ -n "$CATEGORIES_YAML" ] && [ -f "$CATEGORIES_YAML" ]; then
      while IFS= read -r line; do
        [ -n "$line" ] && VALID_CATEGORIES_LIST+=("$line")
      done < <(yaml_eval_python "$CATEGORIES_YAML" "[c['id'] for c in d.get('categories',[])]")
    fi

    [ "${#QUESTION_TRIGGERS_REGEX[@]}" -gt 0 ] && [ "${#VALID_CATEGORIES_LIST[@]}" -gt 0 ] && LOADED=1
  fi
fi

# ============================================================================
# Embedded last-resort fallback
# ============================================================================
if [ "$LOADED" -eq 0 ]; then
  echo "[Question Classifier] WARN: detectors yaml unavailable, using embedded last-resort patterns" >&2
  QUESTION_TRIGGERS_REGEX=(
    '(どちらにしますか|どっちが|どれにしますか)'
    '(\(A\).*\(B\)|①.*②.*どれ)'
    '(判断ください|方針を|聞いてください|確認して|教えてください)'
  )
  VALID_CATEGORIES_LIST=(
    parent_goal_change business_priority external_communication cost_commitment
    ux_brand privacy_security permission_blocked data_destructive security_iam
    legal_compliance public_communication budget_quota hr_evaluation
  )
fi

VALID_CATEGORIES="${VALID_CATEGORIES_LIST[*]}"

# ============================================================================
# 質問・選択肢検出（regex 全マッチで OR 検査）
# ============================================================================
QUESTION_DETECTED=0
for regex in "${QUESTION_TRIGGERS_REGEX[@]}"; do
  if printf '%s\n' "$DETECT_BODY" | grep -qE "$regex"; then
    QUESTION_DETECTED=1
    break
  fi
done

[ "$QUESTION_DETECTED" -eq 0 ] && exit 0

# ============================================================================
# 質問検出 → blocking_question JSON があるか確認
# ============================================================================
JSON_BLOCK=$(printf '%s\n' "$LAST" | awk '/^```json$/{p=1;next}/^```$/{p=0;next}p' | gc_first_json_with_key blocking_question)

if [ -z "$JSON_BLOCK" ]; then
  cat >&2 <<MSG
[Question Classifier] BLOCK: 自由文の質問・選択肢が含まれていますが、structured blocking_question JSON がありません。

人間判断が本当に必要な場合は以下の形式で質問を記述してください:
\`\`\`json
{
  "blocking_question": {
    "category": "<13 カテゴリのいずれか>",
    "question": "<質問文>",
    "proposed_default": "<AI が想定するデフォルト値、Tom 応答なしならこれを採用>",
    "why_blocking": "<なぜブロックするか>"
  }
}
\`\`\`

人間判断ではない場合（AI 即決領域）:
- 自分で answer を決めて続行してください
- 「念のため」「保守的に」「即決すべきなら」などの保留質問は禁止
- 有効カテゴリ:
  ${VALID_CATEGORIES}
MSG
  exit 2
fi

# ============================================================================
# category チェック（enum は yaml から取得）
# ============================================================================
CATEGORY=$(gc_input_field "$JSON_BLOCK" "blocking_question.category")

if [ -z "$CATEGORY" ] || [ "$CATEGORY" = "null" ]; then
  echo "[Question Classifier] BLOCK: blocking_question.category が未指定。" >&2
  echo "  有効カテゴリ: $VALID_CATEGORIES" >&2
  exit 2
fi

if ! echo " $VALID_CATEGORIES " | grep -qF " $CATEGORY "; then
  echo "[Question Classifier] BLOCK: blocking_question.category='$CATEGORY' は enum 外。" >&2
  echo "  → AI 即決領域の可能性。質問せず即決してください。" >&2
  echo "  有効カテゴリ: $VALID_CATEGORIES" >&2
  exit 2
fi

DEFAULT=$(gc_input_field "$JSON_BLOCK" "blocking_question.proposed_default")
if [ -z "$DEFAULT" ] || [ "$DEFAULT" = "null" ]; then
  echo "[Question Classifier WARN] proposed_default が空。Tom 応答なし時の fallback がありません。" >&2
fi

exit 0
