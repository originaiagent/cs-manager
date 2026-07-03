#!/bin/bash
# goal-reminder.sh — UserPromptSubmit hook
# goal-<session_id>.md 不在かつ marker-<session_id> 存在時のみ stdout 1行リマインド。
# 必ず exit 0 で終わること（UserPromptSubmit の exit 2 はプロンプト消去のため禁止）。
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HOOK_DIR/lib/gate_common.sh" ]; then
  # shellcheck source=lib/gate_common.sh
  source "$HOOK_DIR/lib/gate_common.sh"
else
  gc_exit_if_disabled() { if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi; }
  gc_sanitize_id() { printf '%s' "$1" | tr -cd 'A-Za-z0-9_-'; }
fi

gc_exit_if_disabled
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
SESSION_ID=$(gc_sanitize_id "$SESSION_ID")
[ -z "$SESSION_ID" ] && SESSION_ID="unknown"

SESSION_DIR="$CLAUDE_PROJECT_DIR/.claude/.session"
GOAL_FILE="$SESSION_DIR/goal-${SESSION_ID}.md"
MARKER_FILE="$SESSION_DIR/marker-${SESSION_ID}"

if [ ! -f "$GOAL_FILE" ] && [ -f "$MARKER_FILE" ]; then
  echo "🎯 リマインド: goal 未宣言。実装前に .claude/.session/goal-${SESSION_ID}.md へ「🎯 ゴール: <1行>」+「## 完了条件」（≤3件、各行「- [ ] <条件> | 証跡: 」）を書け。"
fi

exit 0
