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

# 直前タスクの完了報告ファイルが同一セッションに残ると validator が古い報告を検査して
# しまう（session_id はセッション中一定）。新しいユーザーターンごとに掃除し、完了報告
# ファイルは「当該ターン中に書き直された物」だけが検査対象になるようにする。
rm -f "$SESSION_DIR/report-${SESSION_ID}.json" 2>/dev/null

# 🎯 ハッシュ初見保存（すり替え検知の基準。goal 宣言済み & 未保存の初回のみ・静粛な書込）
GOALHASH_FILE="$SESSION_DIR/marker-${SESSION_ID}-goalhash"
if [ -f "$GOAL_FILE" ] && [ ! -f "$GOALHASH_FILE" ] && declare -f gc_goal_north_line >/dev/null 2>&1; then
  _NL=$(gc_goal_north_line "$GOAL_FILE")
  [ -n "$_NL" ] && printf '%s' "$_NL" > "$GOALHASH_FILE" 2>/dev/null   # 🎯行未記入時の空保存を防ぐ（非空時のみ保存）
fi

if [ ! -f "$GOAL_FILE" ] && [ -f "$MARKER_FILE" ]; then
  # 前セッション由来の未完遂ゴールが台帳に残っていれば継続を促す（resume/compact で
  # session-start が early-exit する経路の二重防御・読み取りのみ）
  if declare -f gc_unfinished_ledger_line >/dev/null 2>&1; then
    UGL=$(gc_unfinished_ledger_line)
    [ -n "$UGL" ] && printf '⚠️ 未完遂ゴールあり: %s — 継続なら goal へ転記＋台帳エントリのキーを現セッションIDへ付け替えて再開（完遂時に消し込みを検証）。別件なら着手前に判断ログ1行。\n' "$(printf '%s' "$UGL" | head -3 | tr '\n' ' ')"
  fi
  echo "🎯 リマインド: goal 未宣言。実装前に .claude/.session/goal-${SESSION_ID}.md へ「🎯 ゴール: <1行>」+「## 完了条件」（≤3件、各行「- [ ] <条件> | 証跡: 」）を書け。"
elif [ -f "$GOAL_FILE" ]; then
  # 台帳未登録の一度きりの促し（努力目標。宣言直後の登録で不意のコンテナ消滅にも継続を残す）
  LEDGER_NUDGE="$SESSION_DIR/marker-${SESSION_ID}-ledgernudge"
  if [ ! -f "$LEDGER_NUDGE" ] && declare -f gc_ledger_has_entry >/dev/null 2>&1; then
    if ! gc_ledger_has_entry worktree "$SESSION_ID" && ! gc_ledger_has_entry head "$SESSION_ID"; then
      echo "🗒 台帳未登録: このゴールを docs/open-goals.md へ1エントリ追記し goal 宣言と同じコミットに含めると、セッションが切れても継続されます（中断/完遂で gate が登録/消し込みを検証）。"
      : > "$LEDGER_NUDGE" 2>/dev/null
    fi
  fi
fi

exit 0
