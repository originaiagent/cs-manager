#!/bin/bash
# PR 作成前（mcp__github__create_pull_request）に型チェック+テスト実行。
# push 境界の矢面は push-gate.sh。こちらは MCP 経由 PR 用の二重防御として維持。
# 改修 (2026-07): テスト失敗の握り潰し（2>/dev/null ||）を除去し、テスト失敗も exit 2 に。
if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

# push-gate の「テスト未検証」フラグ解除用に共通関数を読み込む（lib 不在でも本体機能は動く）
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HOOK_DIR/lib/gate_common.sh" ]; then
  # shellcheck source=lib/gate_common.sh
  source "$HOOK_DIR/lib/gate_common.sh"
fi
cd "$CLAUDE_PROJECT_DIR" || exit 0

if [ -f "package.json" ]; then
  if [ -f "tsconfig.json" ]; then
    TSC_OUTPUT=$(npx tsc --noEmit 2>&1)
    if [ $? -ne 0 ]; then
      echo "BLOCKED: 型エラーあり。修正してからPRを作成してください：" >&2
      echo "$TSC_OUTPUT" | tail -n 20 >&2
      exit 2
    fi
  fi

  # ---- scripts の読み出し（jq → node フォールバック → fail-closed）----
  # jq 不在マシンでは jq 呼び出しが空文字列になりテスト skip = fail-open で
  # PR 作成が通ってしまうため、jq 不在時は node -e の JSON parse にフォールバック
  # （npm リポなら node は必ずある）。node も無ければ検査不能につき exit 2。
  if command -v jq >/dev/null 2>&1; then
    TEST_AI_SCRIPT=$(jq -r '.scripts["test:ai"] // empty' package.json 2>/dev/null)
    TEST_SCRIPT=$(jq -r '.scripts.test // empty' package.json 2>/dev/null)
  elif command -v node >/dev/null 2>&1; then
    read_script_node() {
      node -e '
        try {
          const p = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
          const v = (p.scripts || {})[process.argv[1]];
          if (typeof v === "string") process.stdout.write(v);
        } catch (e) {
          process.exit(3);
        }
      ' "$1"
    }
    TEST_AI_SCRIPT=$(read_script_node "test:ai")
    RC_AI=$?
    TEST_SCRIPT=$(read_script_node "test")
    RC_T=$?
    if [ "$RC_AI" -ne 0 ] || [ "$RC_T" -ne 0 ]; then
      echo "BLOCKED: package.json を node で parse できない（不正JSON?）。修正してからPRを作成してください。" >&2
      exit 2
    fi
  else
    echo "BLOCKED: jq も node も無く package.json の scripts を検査できないため PR 作成を止める（fail-closed）。" >&2
    exit 2
  fi

  TEST_CMD=""
  if [ -n "$TEST_AI_SCRIPT" ]; then
    TEST_CMD="npm run test:ai"
  elif [ -n "$TEST_SCRIPT" ]; then
    case "$TEST_SCRIPT" in
      *"no test specified"*) TEST_CMD="" ;;   # npm 初期値プレースホルダは対象外
      *) TEST_CMD="npm test" ;;
    esac
  fi

  if [ -n "$TEST_CMD" ]; then
    TEST_OUTPUT=$($TEST_CMD 2>&1)
    TEST_RC=$?
    # テスト完走（pass/fail 問わず。ここまで到達 = timeout せず実行完了）につき、
    # push-gate が timeout fail-open 時に設置した「テスト未検証」フラグを解除する（P2-1）。
    # フラグパスの組み立ては lib/gate_common.sh 経由で push-gate.sh と完全一致。
    if declare -f gc_clear_push_unverified_flag >/dev/null 2>&1; then
      gc_clear_push_unverified_flag
    fi
    if [ "$TEST_RC" -ne 0 ]; then
      echo "BLOCKED: テスト失敗。修正してからPRを作成してください：" >&2
      echo "$TEST_OUTPUT" | tail -n 20 >&2
      exit 2
    fi
  fi
fi
exit 0
