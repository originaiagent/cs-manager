#!/bin/bash
# delegate-nudge.sh — PostToolUse(Edit|Write) hook
# main スレッドの直接編集回数を session_id キーの /tmp カウンタで数え、
# 5の倍数回で「builder サブエージェントへの委譲を検討」を additionalContext で注入する。
# 警告のみ・非ブロック（必ず exit 0）。サブエージェント（agent_id 非空）は対象外。
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

# サブエージェントの編集は対象外（委譲済みの作業なのでカウントしない）
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null)
if [ -n "$AGENT_ID" ]; then exit 0; fi

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
SESSION_ID=$(gc_sanitize_id "$SESSION_ID")
[ -z "$SESSION_ID" ] && SESSION_ID="unknown"

COUNT_FILE="/tmp/claude_delegate_nudge_${SESSION_ID}"
COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
case "$COUNT" in (*[!0-9]*|"") COUNT=0 ;; esac
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNT_FILE"

if [ $((COUNT % 5)) -eq 0 ]; then
  jq -cn --arg msg "直接編集が${COUNT}回連続。定型実装は builder サブエージェントへの委譲を検討（司令塔が自分でやるのはタスク分解・設計判断・難エラー最終判断・統合レビューのみ）。" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $msg}}'
fi

exit 0
