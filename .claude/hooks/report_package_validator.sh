#!/bin/bash
# Report Package Validator — 完了報告 schema 検査 (Stop hook)
# 違反時 exit 2 で停止。Claude Code は schema 適合まで終わらせない。
# 正本: origin-policy/schemas/report_package.schema.json
# 取得: load_detectors.sh 経由で live → cache → bundled fallback

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

INPUT=$(cat)

GC_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$GC_HOOK_DIR/lib/gate_common.sh" ]; then exit 0; fi
# shellcheck source=lib/gate_common.sh
source "$GC_HOOK_DIR/lib/gate_common.sh"

gc_exit_if_stop_active "$INPUT"   # 再入ガード（parser 不在でも grep で先に評価）
# ここから transcript 解析が必要 → jq/node どちらも無ければ fail-closed（9周目P2-A）
gc_require_json_parser

TRANSCRIPT=$(gc_input_field "$INPUT" transcript_path)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi

LAST=$(gc_last_assistant_message "$TRANSCRIPT")

if [ -z "$LAST" ] || [ "$LAST" = "null" ]; then exit 0; fi
REPORT_KEYWORDS='完了報告|report_package|Done\s*条件|完了しました|✅\s*完了|完了です'
if ! printf '%s\n' "$LAST" | grep -qE "$REPORT_KEYWORDS"; then
  exit 0
fi


# 完了報告 + report_package 検証には jq が必須（schema照合の jq 式が多数のため）。
# ここまで到達 = 検証が必要な完了報告なので、jq 不在は fail-closed で止める
# （node では schema 照合を代替しない。brew install jq で解消）
if ! command -v jq >/dev/null 2>&1; then
  echo "[Report Validator] BLOCK: report_package の schema 検証には jq が必要。brew install jq / apt install jq（fail-closed）" >&2
  exit 2
fi
# ============================================================================
# 正本 schema を取得（load_detectors.sh 経由、live → cache → bundled fallback）
# 取得した schema から required / enum を動的抽出して検査ループに注入
# ============================================================================
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${HOOK_DIR}/lib/load_detectors.sh"
SCHEMA_PATH=""

if [ -f "$LIB" ]; then
  # shellcheck source=lib/load_detectors.sh
  source "$LIB"
  SCHEMA_PATH=$(report_package_schema_path 2>/dev/null)
fi

# schema-driven enums / required fields
declare -a REQUIRED_FIELDS
declare -a STATUS_ENUM
declare -a CI_STATUS_ENUM
declare -a SELF_CHECK_FIELDS

if [ -n "$SCHEMA_PATH" ] && [ -f "$SCHEMA_PATH" ]; then
  while IFS= read -r f; do [ -n "$f" ] && REQUIRED_FIELDS+=("$f"); done \
    < <(jq -r '.required[]' "$SCHEMA_PATH" 2>/dev/null)
  while IFS= read -r v; do [ -n "$v" ] && STATUS_ENUM+=("$v"); done \
    < <(jq -r '.properties.status.enum[]' "$SCHEMA_PATH" 2>/dev/null)
  while IFS= read -r v; do [ -n "$v" ] && CI_STATUS_ENUM+=("$v"); done \
    < <(jq -r '.properties.ci_status.properties.status.enum[]' "$SCHEMA_PATH" 2>/dev/null)
  while IFS= read -r f; do [ -n "$f" ] && SELF_CHECK_FIELDS+=("$f"); done \
    < <(jq -r '.properties.self_check.required[]' "$SCHEMA_PATH" 2>/dev/null)
fi

# Embedded last-resort fallback（schema 完全取得不能時）
if [ "${#REQUIRED_FIELDS[@]}" -eq 0 ]; then
  echo "[Report Validator] WARN: schema unavailable, using embedded last-resort fields" >&2
  REQUIRED_FIELDS=(schema_version task_package_id status evidence_urls tests_run ci_status self_check)
  STATUS_ENUM=(done blocked failed partial)
  CI_STATUS_ENUM=(green red pending no_ci)
  SELF_CHECK_FIELDS=(build ui feature regression errors)
fi

# ============================================================================
# JSON ブロック抽出 (```json ... ```)
# ============================================================================
JSON_BLOCK=$(printf '%s\n' "$LAST" | awk '
  /^[[:space:]]*```json[[:space:]]*$/ { in_block=1; next }
  /^[[:space:]]*```[[:space:]]*$/ && in_block==1 { exit }
  in_block==1 { print }
')

if [ -z "$JSON_BLOCK" ]; then
  echo "[Report Validator] BLOCK: 完了報告に report_package JSON ブロックがありません" >&2
  echo "  → \`\`\`json ... \`\`\` で report_package.schema.json 準拠の構造化報告を含めてください" >&2
  echo "  → 必須 field: ${REQUIRED_FIELDS[*]}" >&2
  exit 2
fi

if ! echo "$JSON_BLOCK" | jq empty >/dev/null 2>&1; then
  echo "[Report Validator] BLOCK: report_package JSON 構文エラー" >&2
  echo "$JSON_BLOCK" | jq empty 2>&1 | head -5 >&2
  exit 2
fi

# 必須 field 検査（schema 駆動）
for field in "${REQUIRED_FIELDS[@]}"; do
  if ! echo "$JSON_BLOCK" | jq -e --arg f "$field" 'has($f) and (.[$f] != null)' >/dev/null 2>&1; then
    echo "[Report Validator] BLOCK: 必須 field '$field' が欠如または null" >&2
    exit 2
  fi
done

# status enum（schema 駆動）
STATUS=$(echo "$JSON_BLOCK" | jq -r '.status // empty')
STATUS_ENUM_STR=" ${STATUS_ENUM[*]} "
if ! echo "$STATUS_ENUM_STR" | grep -qF " $STATUS "; then
  echo "[Report Validator] BLOCK: status 不正値 '$STATUS' (期待: ${STATUS_ENUM[*]})" >&2
  exit 2
fi

# evidence_urls
URL_COUNT=$(echo "$JSON_BLOCK" | jq -r '
  if (.evidence_urls | type) == "array" then (.evidence_urls | length) else -1 end
')
if [ "$URL_COUNT" -lt 1 ]; then
  echo "[Report Validator] BLOCK: evidence_urls が空または配列ではない。最低 1 件必須 (現: $URL_COUNT)" >&2
  exit 2
fi
INVALID_URL_ITEMS=$(echo "$JSON_BLOCK" | jq -r '
  .evidence_urls
  | map(select(
      (type != "object")
      or (has("type") | not)
      or (has("url") | not)
      or (.type == null) or (.url == null)
      or (.type == "") or (.url == "")
    ))
  | length
')
if [ "$INVALID_URL_ITEMS" -gt 0 ]; then
  echo "[Report Validator] BLOCK: evidence_urls の要素に type または url が欠如/空" >&2
  exit 2
fi

# tests_run
TEST_COUNT=$(echo "$JSON_BLOCK" | jq -r '
  if (.tests_run | type) == "array" then (.tests_run | length) else -1 end
')
if [ "$TEST_COUNT" -lt 1 ]; then
  echo "[Report Validator] BLOCK: tests_run が空または配列ではない。最低 1 件必須 (現: $TEST_COUNT)" >&2
  exit 2
fi
INVALID_TESTS=$(echo "$JSON_BLOCK" | jq -r '
  .tests_run
  | map(select(
      (type != "object")
      or (has("name") | not) or (has("result") | not)
      or (.name == "") or (.result == "")
    ))
  | length
')
if [ "$INVALID_TESTS" -gt 0 ]; then
  echo "[Report Validator] BLOCK: tests_run の要素に name または result が欠如/空" >&2
  exit 2
fi

# ci_status.status enum + verified_at_source
CI_STATUS=$(echo "$JSON_BLOCK" | jq -r '.ci_status.status // empty')
if [ -z "$CI_STATUS" ]; then
  echo "[Report Validator] BLOCK: ci_status.status が欠如" >&2
  exit 2
fi
CI_ENUM_STR=" ${CI_STATUS_ENUM[*]} "
if ! echo "$CI_ENUM_STR" | grep -qF " $CI_STATUS "; then
  echo "[Report Validator] BLOCK: ci_status.status 不正値 '$CI_STATUS' (期待: ${CI_STATUS_ENUM[*]})" >&2
  exit 2
fi

CI_VERIFIED=$(echo "$JSON_BLOCK" | jq -r '.ci_status.verified_at_source // empty')
if [ -z "$CI_VERIFIED" ]; then
  echo "[Report Validator] BLOCK: ci_status.verified_at_source が欠如。GitHub API 等の実態確認元 URL 必須" >&2
  echo "  → PR ページの merged 表示だけでは不可。GitHub API レスポンス URL を貼ること" >&2
  exit 2
fi

# self_check 必須サブフィールド（schema 駆動）
for f in "${SELF_CHECK_FIELDS[@]}"; do
  V=$(echo "$JSON_BLOCK" | jq -r --arg f "$f" '.self_check[$f] // empty')
  if [ -z "$V" ]; then
    echo "[Report Validator] BLOCK: self_check.$f が欠如" >&2
    exit 2
  fi
done

# 自己申告フレーズ検出（schema外、tool-template 維持）
FORBIDDEN_SELF_CLAIMS=(
  '画面表示[[:space:]]*[OoＯ][KkＫ]'
  '自己確認[[:space:]]*[OoＯ][KkＫ]'
  '体感的に動く'
  '動作確認[[:space:]]*[OoＯ][KkＫ][[:space:]]*$'
  '目視確認[[:space:]]*[OoＯ][KkＫ]'
)
for pattern in "${FORBIDDEN_SELF_CLAIMS[@]}"; do
  if printf '%s\n' "$LAST" | grep -qE "$pattern"; then
    echo "[Report Validator] BLOCK: 自己申告フレーズ検出: '$pattern'" >&2
    echo "  → スクショ URL/ブラウザテストログ/curl 出力を evidence_urls に追加してください" >&2
    exit 2
  fi
done

exit 0
