#!/bin/bash
# goal-gate-stop.sh — Stop hook（ゴールゲート）
# 責務は3つだけ: ①goal未宣言検査 ②完了条件照合 ③証跡形式検査
# （エビデンスURLの実在検査は evidence-check.sh が独立して担当）
# Stop hook は並列実行のため他 hook との順序に依存しない設計。
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$HOOK_DIR/lib/gate_common.sh" ]; then
  echo "[Goal Gate] WARN: lib/gate_common.sh 不在のため検査をスキップ" >&2
  exit 0
fi
# shellcheck source=lib/gate_common.sh
source "$HOOK_DIR/lib/gate_common.sh"

INPUT=$(cat)
gc_exit_if_stop_active "$INPUT"   # 再入ガード（parser 不在でも grep で先に評価）
gc_exit_if_disabled               # .disable-hooks エスケープ（本体より前に評価。10周目P2:
                                  #  9周目の再構築でこの呼び出しが欠落し、.disable-hooks 下でも
                                  #  goal-gate だけが block し続ける実害が出た再発防止マーカー）
# ここから transcript 解析が必要 → jq/node どちらも無ければ fail-closed（9周目P2-A。
# 旧実装の「jq 不在 → WARN + skip」は fail-open だったため廃止）
gc_require_json_parser

SESSION_ID=$(gc_input_field "$INPUT" session_id)
TRANSCRIPT=$(gc_input_field "$INPUT" transcript_path)
SESSION_ID=$(gc_sanitize_id "$SESSION_ID")
[ -z "$SESSION_ID" ] && SESSION_ID="unknown"

SESSION_DIR="$CLAUDE_PROJECT_DIR/.claude/.session"
GOAL_FILE="$SESSION_DIR/goal-${SESSION_ID}.md"
MARKER_FILE="$SESSION_DIR/marker-${SESSION_ID}"

# ============================================================================
# ① goal 未宣言検査
# ============================================================================
if [ ! -f "$GOAL_FILE" ]; then
  if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi
  # 実装形跡（Edit/MultiEdit/Write/NotebookEdit）。サブエージェント（isSidechain）による
  # 委譲実装も数える: builder 委譲のみで実装してもゴール宣言義務は同じ（7周目P2-A）。
  # 本文引用による誤検知はブロック上限2回+エスカレーション通過で許容する（既存設計踏襲）。
  if ! grep -qE '"name"[[:space:]]*:[[:space:]]*"(Edit|MultiEdit|Write|NotebookEdit)"' "$TRANSCRIPT" 2>/dev/null; then
    exit 0  # 会話のみ（実装形跡なし）は素通り
  fi
  COUNT_FILE="/tmp/claude_goal_gate_${SESSION_ID}"
  COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
  case "$COUNT" in (*[!0-9]*|"") COUNT=0 ;; esac
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "$COUNT_FILE"
  if [ "$COUNT" -ge 3 ]; then
    # 3回目はエスカレーション文言のみで通過（無限ループ回避）
    echo "[Goal Gate] エスカレーション: ゴール未宣言のまま3回停止したためゲートを解除。次回は最初の実装前に goal ファイルを必ず書くこと。この件を報告に含めよ。" >&2
    exit 0
  fi
  echo "[Goal Gate] BLOCK(${COUNT}/2): ゴール未宣言。実装（Edit/Write）の形跡があるのに goal ファイルがない。" >&2
  echo "  → .claude/.session/goal-${SESSION_ID}.md に共有フォーマットで書け:" >&2
  echo "     1行目「🎯 ゴール: <1行>」/ 次に「## 完了条件」/ 各条件「- [ ] <条件> | 証跡: 」(≤3件)" >&2
  exit 2
fi

# ============================================================================
# ② 完了条件照合
# ============================================================================
UNCHECKED=$(grep -E '^[[:space:]]*- \[ \]' "$GOAL_FILE" 2>/dev/null)
CHECKED_COUNT=$(grep -cE '^[[:space:]]*- \[[xX]\]' "$GOAL_FILE" 2>/dev/null)
case "$CHECKED_COUNT" in (*[!0-9]*|"") CHECKED_COUNT=0 ;; esac

if [ -n "$UNCHECKED" ] || [ "$CHECKED_COUNT" -eq 0 ]; then
  LAST=$(gc_last_assistant_message "$TRANSCRIPT")
  if [ -n "$LAST" ] && [ "$LAST" != "null" ]; then
    # 全 ```json フェンスの中身を連結抽出（両逃げ道の実 JSON 判定に使う）
    FENCE_JSON=$(printf '%s\n' "$LAST" | awk '
      /^[[:space:]]*```json[[:space:]]*$/ { in_block=1; next }
      /^[[:space:]]*```[[:space:]]*$/ && in_block==1 { in_block=0; next }
      in_block==1 { print }
    ')
    # (i) blocking_question → 人間判断待ちなので通過。
    # 16周目P2-A: 旧実装は文字列包含判定のため、地の文に「blocking_question」と
    # 書くだけで通過できた。```json フェンス内の実 JSON ブロックを抽出し、
    # blocking_question オブジェクトが存在し category / question が非空であることを
    # 検証してから通過させる（enum 検査は question_classifier の責務なので重複しない。
    # ここは構造の実在のみ確認）。
    if [ -n "$FENCE_JSON" ]; then
      BQ_BLOCK=$(printf '%s\n' "$FENCE_JSON" | gc_first_json_with_key blocking_question)
      if [ -n "$BQ_BLOCK" ]; then
        BQ_CATEGORY=$(gc_input_field "$BQ_BLOCK" "blocking_question.category")
        BQ_QUESTION=$(gc_input_field "$BQ_BLOCK" "blocking_question.question")
        if [ -n "$BQ_CATEGORY" ] && [ "$BQ_CATEGORY" != "null" ] && \
           [ -n "$BQ_QUESTION" ] && [ "$BQ_QUESTION" != "null" ]; then
          BQ_OK=1   # 単独では通過させない（下の中断3点セット判定で使用）
        fi
      fi
      # (ii) report_package JSON の status が blocked|partial → 通過。
      # 16周目P2-B: 旧実装は最初の JSON ブロックの top-level status だけを見るため、
      # 無関係なログ断片 {"status":"partial"} で通過できた。そのブロックが
      # report_package であること = top-level に schema_version と task_package_id と
      # status が揃って存在することを要求する（完全な schema 検証は
      # report_package_validator の責務。ここは report_package の同定に足る3キーのみ）。
      RP_BLOCK=$(printf '%s\n' "$FENCE_JSON" | gc_first_json_with_key schema_version)
      if [ -n "$RP_BLOCK" ]; then
        RP_TPID=$(gc_input_field "$RP_BLOCK" task_package_id)
        RP_STATUS=$(gc_input_field "$RP_BLOCK" status)
        if [ -n "$RP_TPID" ] && [ "$RP_TPID" != "null" ]; then
          case "$RP_STATUS" in
            blocked|partial)
              # 17周目P2-A: この逃げ道は「同じ Stop で report_package_validator が
              # 完全 schema 検査を行う」ことが成立前提。validator は完了報告キーワード
              # （GC_REPORT_KEYWORDS = gate_common 共通定義、validator と同一 regex）
              # でのみ発火するため、キーワード無しの 3キースタブはエビデンス無しで
              # 素通りできてしまう。→ キーワードマッチを成立条件に追加する
              # （schema 検証は validator に委譲、goal-gate 側で重複させない設計は維持）。
              if printf '%s\n' "$LAST" | grep -qE "$GC_REPORT_KEYWORDS"; then
                exit 0
              fi
              RP_STUB_HINT=1   # キーワード無しスタブ: (iii)中断宣言でなければ block 時に誘導
              ;;
          esac
        fi
      fi
    fi
    # (i)+(iii) 統合: 中断は「行頭🛑中断」+「blocking_question JSON（category/question 非空）」の
    # 両方が揃った時のみ通過（reporting.md 中断3点セットの機械担保。blocking_question を
    # 参照セクションの奥に置いただけの曖昧な中断も、JSON 無しの🛑中断単独も通さない）
    HAS_STOP_DECL=0
    if printf '%s\n' "$LAST" | grep -q '^🛑中断:'; then HAS_STOP_DECL=1; fi
    # A/B はトム可視の本文（コードフェンス外・「## 参照」より上）に必要。
    # JSON フェンス内の proposed_default や参照セクションに埋めた選択肢は不可。
    # フェンストグルは FENCE_JSON 抽出と同じくインデント付き ``` も対象にする
    # （抽出側だけ寛容だと、インデントフェンス内の A)/B) が本文扱いになり迂回できるため）
    AB_BODY=$(printf '%s\n' "$LAST" | sed '/^## 参照/,$d' | awk 'BEGIN{c=0} /^[[:space:]]*```/{c=1-c; next} !c{print}')
    HAS_AB=0
    if printf '%s\n' "$AB_BODY" | grep -qE 'A[)）]' && printf '%s\n' "$AB_BODY" | grep -qE 'B[)）]'; then HAS_AB=1; fi
    if [ "${BQ_OK:-0}" -eq 1 ] && [ "$HAS_STOP_DECL" -eq 1 ] && [ "$HAS_AB" -eq 1 ]; then exit 0; fi
    if [ "${BQ_OK:-0}" -eq 1 ] && [ "$HAS_STOP_DECL" -eq 1 ]; then
      echo "[Goal Gate] BLOCK: 中断3点セットの「どうする？ A) <推奨案> B) <代替案>」が最上部に無い（reporting.md）。" >&2
      exit 2
    fi
    if [ "${BQ_OK:-0}" -eq 1 ]; then
      echo "[Goal Gate] BLOCK: blocking_question はあるが行頭「🛑中断: <理由1行>」宣言が無い。中断は3点セット（🛑中断行+最上部A/B+blocking_question JSON）で行え（reporting.md）。" >&2
      exit 2
    fi
    if [ "$HAS_STOP_DECL" -eq 1 ]; then
      echo "[Goal Gate] BLOCK: 🛑中断宣言に blocking_question JSON（category/question 非空）が無い。中断は3点セット（🛑中断行+最上部A/B+blocking_question JSON）で行え（reporting.md）。" >&2
      exit 2
    fi
  fi
  if [ "${RP_STUB_HINT:-0}" -eq 1 ]; then
    echo "[Goal Gate] BLOCK: blocked/partial の report_package はあるが、完了報告キーワードが無いため validator の完全検査が走らない（エビデンス無し素通りは不可）。" >&2
    echo "  → 中断なら行頭「🛑中断: 理由」を書け。報告なら完了報告キーワード（例: 完了報告）+ 完全な report_package を書け。" >&2
    exit 2
  fi
  if [ "$CHECKED_COUNT" -eq 0 ] && [ -z "$UNCHECKED" ]; then
    echo "[Goal Gate] BLOCK: goal ファイルに完了条件（「- [ ] <条件> | 証跡: 」行）が1件もない。共有フォーマットで≤3件書け。" >&2
  else
    echo "[Goal Gate] BLOCK: 完了条件が未達:" >&2
    printf '%s\n' "$UNCHECKED" | sed 's/^/  /' >&2
    echo "  → 横道に逸れていないか goal と照合せよ。達成済みなら「- [x] <条件> | 証跡: <非空テキスト>」に更新。" >&2
    echo "  → 中断するなら会話メッセージの行頭に「🛑中断: 理由」を書け。" >&2
  fi
  exit 2
fi

# ============================================================================
# ③ 証跡形式検査（全条件が ✅ のとき）
# ============================================================================
NO_EVIDENCE=$(grep -E '^[[:space:]]*- \[[xX]\]' "$GOAL_FILE" 2>/dev/null \
  | grep -vE '\|[[:space:]]*証跡:[[:space:]]*[^[:space:]]')
if [ -n "$NO_EVIDENCE" ]; then
  echo "[Goal Gate] BLOCK: 証跡なしの✅は不可。以下の行に「| 証跡: <非空テキスト(生ログ引用/ファイルパス/URL)>」を併記せよ:" >&2
  printf '%s\n' "$NO_EVIDENCE" | sed 's/^/  /' >&2
  exit 2
fi

# 作業記録の強制: docs/progress.md がセッション開始（marker）以降に更新されていること
PROGRESS_FILE="$CLAUDE_PROJECT_DIR/docs/progress.md"
if [ -f "$MARKER_FILE" ]; then
  if [ ! -f "$PROGRESS_FILE" ] || [ ! "$PROGRESS_FILE" -nt "$MARKER_FILE" ]; then
    echo "[Goal Gate] BLOCK: 全条件✅だが docs/progress.md がセッション開始以降更新されていない。docs/progress.md に作業記録を追記せよ。" >&2
    exit 2
  fi
fi

exit 0
