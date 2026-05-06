#!/bin/bash
# 危険なgit操作をブロック + mainブランチ直接push防止
if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [ -z "$COMMAND" ]; then exit 0; fi

DANGEROUS_PATTERNS=(
  "git push.*--force" "git push.*-f" "git reset --hard"
  "git clean -fd" "git clean -f" "git branch -D"
  "git checkout -- " "git restore [^-]"
  "git stash drop" "git stash clear" "rm -rf /"
  "gcloud run deploy --source"
)
for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qiE "$pattern"; then
    echo "BLOCKED: 危険なコマンド検出: '$COMMAND'" >&2
    exit 2
  fi
done

BRANCH=$(cd "$CLAUDE_PROJECT_DIR" && git symbolic-ref --short HEAD 2>/dev/null || echo "")
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  if echo "$COMMAND" | grep -qE "^git push"; then
    echo "BLOCKED: mainブランチから直接pushは禁止。claude/xxxブランチでPRを出してください。" >&2
    exit 2
  fi
fi
exit 0
