#!/bin/bash
# PR作成前に型チェック+テスト実行
if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi
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
  npm run test:ai --if-present 2>/dev/null || npm test --if-present 2>/dev/null
fi
exit 0
