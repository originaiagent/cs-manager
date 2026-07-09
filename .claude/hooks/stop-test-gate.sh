#!/bin/bash
# 完了報告時テスト強制 + 無限ループ対策 + 3回失敗エスカレーション
# 改修 (2026-07):
#   ① 毎 Stop フルテスト廃止 → 最終 assistant メッセージが完了報告キーワードを
#      含む時のみ実行（transcript 解析は report_package_validator.sh の方式を
#      lib/gate_common.sh 経由で流用）
#   ② 「npm run test:ai --if-present || npm test」の || 短絡バグを明示分岐に修正
#   ③ md5sum → cksum（POSIX 互換、macOS/Linux 両対応）
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。
if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi
INPUT=$(cat)

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$HOOK_DIR/lib/gate_common.sh" ]; then exit 0; fi
# shellcheck source=lib/gate_common.sh
source "$HOOK_DIR/lib/gate_common.sh"

gc_exit_if_stop_active "$INPUT"   # 再入ガード（parser 不在でも grep で先に評価）
# ここから transcript 解析が必要 → jq/node どちらも無ければ fail-closed（9周目P2-A）
gc_require_json_parser

# ---- 完了報告キーワードを含む時のみテスト実行（毎 Stop フルテスト廃止）----
TRANSCRIPT=$(gc_input_field "$INPUT" transcript_path)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then exit 0; fi
LAST=$(gc_last_assistant_message "$TRANSCRIPT")
if [ -z "$LAST" ] || [ "$LAST" = "null" ]; then exit 0; fi
# ---- 発火判定 + 完了主張の判定 ----
# 発火 = 報告キーワードマッチ or 完了主張。完了主張の定義（GC_DONE_KEYWORDS または
# report_package status=done）は lib/gate_common.sh の gc_is_done_claim に単一ソース化
# （evidence-check.sh の動作確認実績ゲートと共用）。見出しもキーワードも無い素の
# report_package(status=done) がキーワードゲートで素通りしてテストを回避する穴を塞ぐ。
# 進捗報告(partial/blocked)では npm テストを強制しない（未検証フラグの開示確認のみ）。
KEYWORD_HIT=0
if printf '%s\n' "$LAST" | grep -qE "$GC_REPORT_KEYWORDS"; then KEYWORD_HIT=1; fi
IS_DONE_CLAIM=0
REPORT_BODY=""
if declare -f gc_session_report_file >/dev/null 2>&1; then
  _RF=$(gc_session_report_file "$INPUT")
  [ -n "$_RF" ] && [ -f "$_RF" ] && REPORT_BODY=$(cat "$_RF" 2>/dev/null)
fi
if gc_is_done_claim "$LAST" "$REPORT_BODY"; then IS_DONE_CLAIM=1; fi
if [ "$KEYWORD_HIT" -eq 0 ] && [ "$IS_DONE_CLAIM" -eq 0 ]; then exit 0; fi

# ---- push-gate テスト未検証フラグの検査（P2-C: evidence-check から責務移管）----
# Stop hook は並列実行のため、evidence-check がフラグを検査すると
# 「本 hook がテスト完走でフラグを解除する前に stale フラグを読んで誤ブロック」する
# レースが起きる。テスト実行とフラグ検査を本 hook 内で直列化して根絶する（単一オーナー）。
# テストを実行できない経路（package.json 無し / テスト script 無し / プレースホルダ）と、
# テスト完走後もフラグが残存する経路（= git -C 別リポ宛て未検証。単一キー方式）で、
# 完了報告に『テスト未検証』の明記が無ければ block する。
exit_with_unverified_flag_check() {
  local flag
  flag=$(gc_push_unverified_flag)
  if [ -f "$flag" ] && ! printf '%s\n' "$LAST" | grep -q 'テスト未検証'; then
    echo "[stop-test-gate] BLOCK: push-gate のテストが timeout で未完走のまま push されている（flag: $flag）。" >&2
    echo "  → 完了報告と PR 本文に『テスト未検証』と明記せよ（明記すれば通過）。" >&2
    echo "  → もしくはテストを完走させよ（完走すればフラグは自動解除される）。" >&2
    exit 2
  fi
  exit 0
}

cd "$CLAUDE_PROJECT_DIR" || exit 0

# ---- 開示パスの尊重（11周目P2-A: テスト実行より前に評価）----
# push-gate の timeout フラグが存在し、かつ完了報告に『テスト未検証』が明記済みなら、
# テスト再実行をスキップして通過する（project= の一致・不一致を問わず開示済みを尊重）。
# timeout するテストを再実行すると Stop hook の 180s 上限までハングし、設計した
# 開示パスが実質使えなくなるため。フラグ有り+開示無しは従来どおりテスト実行で検証を試みる。
UNVERIFIED_FLAG_PATH=$(gc_push_unverified_flag)
if [ -f "$UNVERIFIED_FLAG_PATH" ] && printf '%s\n' "$LAST" | grep -q 'テスト未検証'; then
  echo "[stop-test-gate] 『テスト未検証』の開示を確認。テスト再実行はスキップして通過（フラグはテスト完走まで残置）" >&2
  exit 0
fi

# ---- 完了主張なし（進捗報告等）→ npm テストはスキップし、未検証フラグの開示確認のみ ----
if [ "$IS_DONE_CLAIM" -eq 0 ]; then exit_with_unverified_flag_check; fi

if [ ! -f "package.json" ]; then exit_with_unverified_flag_check; fi
# ---- テストコマンドの明示分岐（|| 短絡イディオムは禁止）----
TEST_AI_SCRIPT=$(gc_pkg_script "test:ai")
TEST_SCRIPT=$(gc_pkg_script "test")

TEST_OUTPUT=""
TEST_EXIT=0
if [ -n "$TEST_AI_SCRIPT" ]; then
  TEST_OUTPUT=$(gc_run_limited 120 npm run test:ai 2>&1)
  TEST_EXIT=$?
elif [ -n "$TEST_SCRIPT" ]; then
  case "$TEST_SCRIPT" in
    *"no test specified"*) exit_with_unverified_flag_check ;;   # npm 初期値プレースホルダは対象外
  esac
  TEST_OUTPUT=$(gc_run_limited 120 npm test 2>&1)
  TEST_EXIT=$?
else
  exit_with_unverified_flag_check
fi

# ---- 内部 timeout（120s）は制御された block で返す（11周目P2-A）----
# hook 全体の 180s kill（メッセージ無しの静かな失敗）ではなく、明示メッセージ +
# 未検証フラグの設置/残置 + exit 2 で「テスト未検証と明記せよ」を促す。
if gc_is_timeout_rc "$TEST_EXIT"; then
  if [ ! -f "$UNVERIFIED_FLAG_PATH" ]; then
    printf 'reason=stop-test-gate-timeout-120s\nat=%s\nproject=%s\n' \
      "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$CLAUDE_PROJECT_DIR" > "$UNVERIFIED_FLAG_PATH" 2>/dev/null
  fi
  echo "[stop-test-gate] BLOCK: テストが 120s で完走しない（timeout）。未検証フラグを残置した: $UNVERIFIED_FLAG_PATH" >&2
  echo "  → 完了報告と PR 本文に『テスト未検証』と明記せよ（明記すれば通過）。" >&2
  echo "  → もしくはテストを 120s 内に完走するよう修正せよ（完走すればフラグは自動解除）。" >&2
  exit 2
fi

# テスト完走（pass/fail 問わず。ここまで到達 = timeout せず実行完了）につき、
# push-gate が timeout fail-open 時に設置した「テスト未検証」フラグを解除する（P2-1）。
# 解除はフラグ本文 project= が自リポ（CLAUDE_PROJECT_DIR）一致時のみ（7周目P2-B 単一キー方式）。
# フラグパスの組み立ては lib/gate_common.sh 経由で push-gate.sh と完全一致。
gc_clear_push_unverified_flag

FAIL_FILE="/tmp/claude_test_fail_$(gc_path_hash "$CLAUDE_PROJECT_DIR")"
if [ $TEST_EXIT -ne 0 ]; then
  COUNT=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
  case "$COUNT" in (*[!0-9]*|"") COUNT=0 ;; esac
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "$FAIL_FILE"

  if [ "$COUNT" -ge 3 ]; then
    echo "【エスカレーション】テスト3回連続失敗。自律修正を中断し報告してください。" >&2
    echo "$TEST_OUTPUT" | tail -n 30 >&2
    rm -f "$FAIL_FILE"
    exit 2
  fi
  echo "テスト失敗（${COUNT}/3回目）。以下を解析して修正：" >&2
  echo "$TEST_OUTPUT" | tail -n 30 >&2
  exit 2
fi

rm -f "$FAIL_FILE"

# 別リポ宛て（git -C）の未検証フラグが残存する場合、自リポのテスト完走では解消されない。
# 完了報告に『テスト未検証』の明記が無ければ block して終了する（7周目P2-B）。
exit_with_unverified_flag_check
