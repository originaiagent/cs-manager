#!/bin/bash
# Question Router Invoke — blocking_question JSON を origin-policy/scripts/question_router.py
# に流して人間判断 / AI 判断ルーティング。Phase 3 Lane 3 導入。
#
# 役割:
#   - Stop イベントの transcript から blocking_question JSON を抽出
#   - python3 question_router.py に pipe して exit code を解釈
#       0  → 人間判断（トム interrupt 別系統。本 hook は静かに通過）
#       10 → AI 判断（管理クロード向けプロンプトを stdout に出して exit 0、
#             Stop chain は止めずに Claude Code がそのまま読めるようにする）
#       2  → schema 違反（router の stderr を出して exit 2 で Stop）
#       それ以外 → 想定外、exit 2
#
# 前提:
#   - 既存 question_classifier.sh の後段に配線される想定（schema OK 済み）
#   - 現状 classifier は 13 enum 外を BLOCK するため、Lane 2 で AI enum
#     pass-through を実装するまでは AI 判断ルーティングは発火しない。
#   - 暫定運用は origin-policy/docs/question_router.md 参照。
#
# パス解決: ORIGIN_POLICY_DIR > ~/dev/origin-policy > 不在時は静かに pass。

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

INPUT=$(cat)

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$HOOK_DIR/lib/gate_common.sh" ]; then exit 0; fi
# shellcheck source=lib/gate_common.sh
source "$HOOK_DIR/lib/gate_common.sh"
gc_exit_if_stop_active "$INPUT"   # 再入ガード（parser 不在でも grep で先に評価）

ROUTER="${ORIGIN_POLICY_DIR:-$HOME/dev/origin-policy}/scripts/question_router.py"
if [ ! -f "$ROUTER" ]; then
  echo "[question_router_invoke] WARN: router not found at $ROUTER" >&2
  echo "  Set ORIGIN_POLICY_DIR or clone origin-policy under ~/dev/origin-policy." >&2
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[question_router_invoke] WARN: python3 not found, skipping" >&2
  exit 0
fi

# ここから transcript 解析が必要 → jq/node どちらも無ければ fail-closed（9周目P2-A）
gc_require_json_parser

TRANSCRIPT=$(gc_input_field "$INPUT" transcript_path)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi

LAST=$(gc_last_assistant_message "$TRANSCRIPT")

if [ -z "$LAST" ] || [ "$LAST" = "null" ]; then exit 0; fi

# ```json コードブロックから blocking_question を含む最初の object を取得
JSON_BLOCK=$(printf '%s\n' "$LAST" \
  | awk '/^```json$/{p=1;next}/^```$/{p=0;next}p' \
  | gc_first_json_with_key blocking_question)
# blocking_question が無い場合は本 hook では何もしない（classifier 側の責務）
[ -z "$JSON_BLOCK" ] && exit 0

ERR_TMP=$(mktemp -t qrouter.err.XXXXXX)
PROMPT=$(printf '%s' "$JSON_BLOCK" | python3 "$ROUTER" 2>"$ERR_TMP")
ROUTER_EXIT=$?

case "$ROUTER_EXIT" in
  0)
    # 人間判断 — トム interrupt は別系統。stdout を出さずに通過。
    rm -f "$ERR_TMP"
    exit 0
    ;;
  10)
    # AI 判断 — 管理クロード向けプロンプトを stdout に出して Stop chain を止めない
    printf '%s\n' "$PROMPT"
    rm -f "$ERR_TMP"
    exit 0
    ;;
  2)
    # schema 違反 — Claude Code に差し戻し
    cat "$ERR_TMP" >&2
    rm -f "$ERR_TMP"
    exit 2
    ;;
  *)
    echo "[question_router_invoke] unexpected exit code from router: $ROUTER_EXIT" >&2
    [ -s "$ERR_TMP" ] && cat "$ERR_TMP" >&2
    rm -f "$ERR_TMP"
    exit 2
    ;;
esac
