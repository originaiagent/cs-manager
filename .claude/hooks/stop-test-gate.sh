#!/bin/bash
# 作業完了時テスト強制 + 無限ループ対策 + 3回失敗エスカレーション
if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi
INPUT=$(cat)
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then exit 0; fi
cd "$CLAUDE_PROJECT_DIR" || exit 0
if [ ! -f "package.json" ]; then exit 0; fi

HAS_TEST=$(node -e "const p=require('./package.json'); console.log(p.scripts && (p.scripts['test:ai'] || p.scripts['test']) ? 'yes' : 'no')" 2>/dev/null)
if [ "$HAS_TEST" != "yes" ]; then exit 0; fi

TEST_OUTPUT=$(npm run test:ai --if-present 2>&1 || npm test 2>&1)
TEST_EXIT=$?

if [ $TEST_EXIT -ne 0 ]; then
  FAIL_FILE="/tmp/claude_test_fail_$(echo "$CLAUDE_PROJECT_DIR" | md5sum | cut -d' ' -f1)"
  COUNT=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
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

rm -f "/tmp/claude_test_fail_$(echo "$CLAUDE_PROJECT_DIR" | md5sum | cut -d' ' -f1)"
exit 0
