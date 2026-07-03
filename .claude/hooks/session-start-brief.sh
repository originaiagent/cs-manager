#!/bin/bash
# session-start-brief.sh — SessionStart hook（matcher: startup|clear）
# stdout(exit 0) は Claude のコンテキストに注入される。
#   ① goal ファイル（🎯ゴール1行+完了条件≤3）の宣言指示
#   ② docs/origin-integration-map.md の鮮度警告（調査日が30日超過）
#   ③ main ブランチなら feature ブランチ作成の指示
# あわせて .claude/.session/ の初期化（48時間より古い goal-*/marker-* の掃除、
# marker-<session_id> の touch）を行う。ファイル不在時は各項 skip。
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

INPUT=$(cat)
# session_id/source の抽出は gc_input_field（jq→node フォールバック）経由（15周目P3:
# jq 不在(node あり)マシンで marker 作成・ブリーフ注入が黙って無効化されるのを防ぐ）。
# gate_common 不在・両 parser 不在は advisory hook につき従来どおり静かに exit 0
# （ゲートではないので fail-closed にしない）。
if declare -f gc_input_field >/dev/null 2>&1; then
  [ -z "$(gc_json_parser)" ] && exit 0
  SESSION_ID=$(gc_input_field "$INPUT" session_id)
  SOURCE=$(gc_input_field "$INPUT" source)
else
  if ! command -v jq >/dev/null 2>&1; then exit 0; fi
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
  SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // empty' 2>/dev/null)
fi

# matcher(startup|clear) が正だが、二重防御: resume/compact では基準時刻を動かさない
case "$SOURCE" in
  resume|compact) exit 0 ;;
esac

SESSION_ID=$(gc_sanitize_id "$SESSION_ID")
[ -z "$SESSION_ID" ] && SESSION_ID="unknown"

SESSION_DIR="$CLAUDE_PROJECT_DIR/.claude/.session"
mkdir -p "$SESSION_DIR" 2>/dev/null

# 48時間(2880分)より古い goal-*/marker-* を掃除（並行セッションの新しいファイルは消さない）
find "$SESSION_DIR" -maxdepth 1 -type f \( -name 'goal-*' -o -name 'marker-*' \) -mmin +2880 -delete 2>/dev/null

# セッションマーカー（goal-gate の基準時刻）
touch "$SESSION_DIR/marker-$SESSION_ID" 2>/dev/null

# ---- ① goal 宣言指示（常時）----
cat <<BRIEF
📋 セッション開始ブリーフ:
・最初の実装（Edit/Write）前に .claude/.session/goal-${SESSION_ID}.md へ 🎯ゴール1行+完了条件≤3 を共有フォーマットで書け。
  共有フォーマット: 1行目「🎯 ゴール: <1行>」、次に「## 完了条件」、各条件は「- [ ] <条件> | 証跡: 」。
  達成時は「- [x] <条件> | 証跡: <非空テキスト(生ログ引用/ファイルパス/URL)>」に更新する。
  中断する場合は会話メッセージの行頭に「🛑中断: <理由>」を書く。
BRIEF

# ---- ② integration-map 鮮度警告（ファイル不在 or 調査日不明なら skip）----
MAP_FILE="$CLAUDE_PROJECT_DIR/docs/origin-integration-map.md"
if [ -f "$MAP_FILE" ]; then
  MAP_DATE=$(grep -m1 '調査日' "$MAP_FILE" 2>/dev/null | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
  if [ -n "$MAP_DATE" ]; then
    if date --version >/dev/null 2>&1; then
      MAP_EPOCH=$(date -d "$MAP_DATE" +%s 2>/dev/null)   # GNU date (Linux)
    else
      MAP_EPOCH=$(date -j -f '%Y-%m-%d' "$MAP_DATE" +%s 2>/dev/null)  # BSD date (macOS)
    fi
    if [ -n "$MAP_EPOCH" ]; then
      AGE_DAYS=$(( ( $(date +%s) - MAP_EPOCH ) / 86400 ))
      if [ "$AGE_DAYS" -gt 30 ]; then
        echo "・⚠️ docs/origin-integration-map.md の調査日(${MAP_DATE})は${AGE_DAYS}日前で鮮度切れの可能性。連携はCore APIで裏取りせよ（integration-map md はキャッシュ、正は origin-core）。"
      fi
    fi
  fi
fi

# ---- ③ main ブランチ警告 ----
BRANCH=$(git -C "$CLAUDE_PROJECT_DIR" symbolic-ref --short HEAD 2>/dev/null || echo "")
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "・⚠️ 現在 ${BRANCH} ブランチにいる。実装前に featureブランチ（claude/xxx）を切れ。mainへの直接pushは禁止。"
fi

exit 0
