#!/bin/bash
# Policy Gate Stop Hook — Tier 0 R1/R3 検査
# 違反時 exit 2 で停止、Claude Code は次に進めない
# 正本: origin-policy/rules/tier0_detectors.yaml
# 検出パターンは load_detectors.sh 経由で正本から取得（live → cache → bundled fallback）

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

INPUT=$(cat)

if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then exit 0; fi

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi

if command -v tac >/dev/null 2>&1; then REVERSE="tac"; else REVERSE="tail -r"; fi

LAST=$($REVERSE "$TRANSCRIPT" 2>/dev/null | head -200 | jq -rs '
  map(select(.type == "assistant" and .message.content != null))
  | first
  | (.message.content // [])
  | map(select(.type == "text") | .text)
  | join("\n")
' 2>/dev/null)

if [ -z "$LAST" ] || [ "$LAST" = "null" ]; then exit 0; fi

BODY=$(printf '%s\n' "$LAST" | sed '/^---$/,/^参照/d' | sed '/^## 参照/,$d')
BODY_NO_CODE=$(printf '%s\n' "$BODY" | awk 'BEGIN{c=0} /^```/{c=1-c; next} !c{print}')

# ============================================================================
# 検出パターンを正本（origin-policy/rules/tier0_detectors.yaml）から取得
# ============================================================================
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${HOOK_DIR}/lib/load_detectors.sh"

R3_BLOCK_PATTERNS=()
R1_FORBIDDEN_PATTERNS=()
R1_TEMPTATION_PATTERNS=()
DETECTORS_LOADED=0

if [ -f "$LIB" ]; then
  # shellcheck source=lib/load_detectors.sh
  source "$LIB"
  if yaml_parser_available; then
    YAML_PATH=$(policy_gate_yaml_path 2>/dev/null)
    if [ -n "$YAML_PATH" ] && [ -f "$YAML_PATH" ]; then
      # R3: severity=block の正規表現を抽出
      while IFS= read -r line; do
        [ -n "$line" ] && R3_BLOCK_PATTERNS+=("$line")
      done < <(yaml_eval_python "$YAML_PATH" "[p['regex'] for p in d.get('r3_internal_id_in_body',{}).get('patterns',[]) if p.get('severity')=='block']")
      # R1 forbidden phrase: trigger_patterns で type=forbidden_phrase の regex
      while IFS= read -r line; do
        [ -n "$line" ] && R1_FORBIDDEN_PATTERNS+=("$line")
      done < <(yaml_eval_python "$YAML_PATH" "[p['regex'] for p in d.get('r1_question_detection',{}).get('trigger_patterns',[]) if p.get('type')=='forbidden_phrase']")
      # R1 temptation: type=temptation_word
      while IFS= read -r line; do
        [ -n "$line" ] && R1_TEMPTATION_PATTERNS+=("$line")
      done < <(yaml_eval_python "$YAML_PATH" "[p['regex'] for p in d.get('r1_question_detection',{}).get('trigger_patterns',[]) if p.get('type')=='temptation_word']")
      [ "${#R3_BLOCK_PATTERNS[@]}" -gt 0 ] && DETECTORS_LOADED=1
    fi
  fi
fi

# ============================================================================
# Embedded last-resort fallback（lib/ 不在 or yaml parser 不在 or yaml 取得完全失敗）
# 安全側として BLOCK 維持できる最小セットをハードコード
# ============================================================================
if [ "$DETECTORS_LOADED" -eq 0 ]; then
  echo "[Policy Gate] WARN: detectors yaml unavailable, using embedded last-resort patterns" >&2
  R3_BLOCK_PATTERNS=(
    'Phase[[:space:]]*[0-9]+[a-z]?'
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  )
  R1_FORBIDDEN_PATTERNS=(
    '即決すべきなら'
    'トム判断仰がず'
    '爆速モード崩した自覚'
  )
  R1_TEMPTATION_PATTERNS=(
    '念のため'
    '一応'
    '保守的に'
    '慎重を期して'
    '事前に潰して'
    '方針確認してから'
    '調査だけ先に'
    '段取り感'
    '安心感'
  )
fi

# ============================================================================
# R3 違反検出（本文・コードブロック外のみ対象）
# ============================================================================
for pattern in "${R3_BLOCK_PATTERNS[@]}"; do
  if printf '%s\n' "$BODY_NO_CODE" | grep -qiE "$pattern"; then
    echo "[Policy Gate] R3 violation: matched '$pattern'. Move ID to '参照' section." >&2
    exit 2
  fi
done

# ============================================================================
# R1 forbidden phrase（出力全体対象）
# ============================================================================
for pattern in "${R1_FORBIDDEN_PATTERNS[@]}"; do
  if printf '%s\n' "$LAST" | grep -qE "$pattern"; then
    echo "[Policy Gate] R1 violation: forbidden phrase matched '$pattern'. AI 即決領域です。" >&2
    exit 2
  fi
done

# ============================================================================
# 自己停止フレーズ（origin-policy 未管理。tool-template ローカル維持）
# レーン別タスクで yaml に追加するか整理予定
# ============================================================================
SELF_STOP_PATTERNS=(
  '自律停止'
  '次セッションまで停止'
  '朝トム時間'
  'ここまでにします'
  '区切り良いので'
  '今日はここまで'
)
for pattern in "${SELF_STOP_PATTERNS[@]}"; do
  if printf '%s\n' "$LAST" | grep -q "$pattern"; then
    echo "[Policy Gate] R1 violation: self-stop phrase '$pattern'. 続行してください。" >&2
    exit 2
  fi
done

# ============================================================================
# R1 temptation word（warn のみ、停止しない）
# ============================================================================
for pattern in "${R1_TEMPTATION_PATTERNS[@]}"; do
  if printf '%s\n' "$LAST" | grep -qE "$pattern"; then
    echo "[Policy Gate WARN] R1 temptation matched '$pattern'. 即 GO 判定 4 項目に戻ってください。" >&2
  fi
done

exit 0
