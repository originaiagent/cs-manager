#!/bin/bash
# 機密ファイルとHookスクリプトの改ざん防止
if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
if [ -z "$FILE_PATH" ]; then exit 0; fi

PROTECTED=(".env.production" ".env.local" ".claude/hooks/" ".claude/settings.json")
for pattern in "${PROTECTED[@]}"; do
  if echo "$FILE_PATH" | grep -qF "$pattern"; then
    echo "BLOCKED: '$FILE_PATH' は保護されたファイルです。" >&2
    exit 2
  fi
done
exit 0
