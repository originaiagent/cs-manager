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

# 48時間(2880分)より古い goal-*/marker-*/report-* を掃除（並行セッションの新しいファイルは消さない）
find "$SESSION_DIR" -maxdepth 1 -type f \( -name 'goal-*' -o -name 'marker-*' -o -name 'report-*' \) -mmin +2880 -delete 2>/dev/null

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

# ---- ⑤ 構造マップ参照の促し（毎セッションのコード再読・連携誤解を減らす）----
# 実装前にコードを grep で読み解く前に「地図」（architecture.md / CLAUDE.md 連携情報）を見る。
# 地図がテンプレ雛形のまま（未記入）なら、本セッションで実態を追記して以後の再読コストを無くす。
echo "・実装前に docs/architecture.md と CLAUDE.md「連携情報」を読み、ツール構成・連携先を把握せよ（コードを grep で追う前に地図を見る）。"
ARCH_FILE="$CLAUDE_PROJECT_DIR/docs/architecture.md"
if [ -f "$ARCH_FILE" ] && grep -qE '\{(TOOL_NAME|TOOL_DESCRIPTION|FRAMEWORK|DEPLOY_TARGET|DATABASE|LIBRARIES|PRODUCTION_URL|PREVIEW_URL|DIRECTORY_STRUCTURE|SUPABASE_PROJECT_ID|PROJECT_SPECIFIC_NOTES|INTEGRATION_NOTES|LANGUAGE)\}|（初期セットアップ後に自動記載）|（開発進行に応じて追記）|（必要に応じて追記）' "$ARCH_FILE" 2>/dev/null; then
  echo "  → ⚠️ docs/architecture.md がテンプレ雛形のまま（未記入箇所あり）。本セッションで実態（構成・API・環境変数・連携先）を追記し、次回以降の再読コストを無くせ。"
fi

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

# ---- ④ ルール鮮度チェック（対象は .claude/ 配下のみ。ロード対象を増やしたら判定パスも更新すること）----
# 「セッションが新しい≠ルールが最新」: 古い作業ブランチ引き継ぎで origin/main の最新
# 行動ルール未取込のまま動くのを検知する。hook は検知と推奨コマンドの提示のみ（自動実行しない）。
# 限界: 子リポで sync PR 未マージの場合は origin/main 自体が古く検知不能（配布運用の範囲）。
FRESH_NOTE=""
if declare -f gc_run_limited >/dev/null 2>&1; then
  # 明示 refspec で refs/remotes/origin/main を確実に更新（FETCH_HEAD のみ更新される形を防ぐ）。
  # timeout は git ネイティブ（http lowSpeed / ssh ConnectTimeout+BatchMode）+ gc_run_limited 10s の二重。
  # gc_run_limited の kill で親 git が落ちても、転送子プロセスは自身の lowSpeed timeout で自然終了する。
  if ! GIT_TERMINAL_PROMPT=0 gc_run_limited 10 \
    git -C "$CLAUDE_PROJECT_DIR" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=5 \
      -c core.sshCommand='ssh -o ConnectTimeout=5 -o BatchMode=yes' \
      fetch --no-tags --quiet origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null 2>&1; then
    FRESH_NOTE="（フェッチ未達・ローカル既知のmainと比較）"
  fi
else
  FRESH_NOTE="（フェッチ省略・ローカル既知のmainと比較）"
fi
if git -C "$CLAUDE_PROJECT_DIR" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1; then
  BEHIND=$(git -C "$CLAUDE_PROJECT_DIR" rev-list --count HEAD..origin/main -- .claude/ 2>/dev/null || echo 0)
  case "$BEHIND" in (*[!0-9]*|"") BEHIND=0 ;; esac
  # コミット履歴上は遅れていても内容が同一（cherry-pick/手動反映済み）なら警告しない
  if [ "$BEHIND" -gt 0 ] && ! git -C "$CLAUDE_PROJECT_DIR" diff --quiet HEAD origin/main -- .claude/ 2>/dev/null; then
    AHEAD=$(git -C "$CLAUDE_PROJECT_DIR" rev-list --count origin/main..HEAD -- .claude/ 2>/dev/null || echo 0)
    case "$AHEAD" in (*[!0-9]*|"") AHEAD=0 ;; esac
    # .claude/.session/ は本 hook 自身が直前に作るセッション一時ファイル（未追跡）で、
    # origin/main に存在せず restore でも触れないため dirty 判定から除外する
    DIRTY_CLAUDE=$(git -C "$CLAUDE_PROJECT_DIR" status --porcelain -- .claude/ ':(exclude).claude/.session' 2>/dev/null)
    echo "・⚠️ ルール鮮度切れ${FRESH_NOTE}: このブランチの行動ルール(.claude/)は origin/main より ${BEHIND} コミット古い（セッションが新しくてもルールは最新ではない）。"
    if [ "$AHEAD" -eq 0 ] && [ -z "$DIRTY_CLAUDE" ]; then
      echo "  → 実装前に取り込め（可逆・自律境界内）: git restore --source=origin/main --staged --worktree .claude/ && git commit -m \"chore: catch up .claude from origin/main\" -- .claude/"
      if [ -n "$(git -C "$CLAUDE_PROJECT_DIR" diff --name-only HEAD origin/main -- .claude/hooks/ .claude/settings.json 2>/dev/null)" ]; then
        echo "  → 実行系(hooks/設定)も更新される。取り込み後キリの良いところでセッション再起動を推奨（再起動まで一部旧設定で動く）。"
      fi
    else
      echo "  → このブランチは .claude/ を独自変更中 or 未コミット変更あり（自動取込コマンドは提示しない）。取り込むか、古いルールのまま進む場合はトムに平易に一言警告してから作業せよ。"
    fi
  fi
fi

exit 0
