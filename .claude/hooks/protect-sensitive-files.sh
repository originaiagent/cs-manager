#!/bin/bash
# 機密ファイルと Hook スクリプトの改ざん防止 + ルール正本ガード
#
# ルール類（.claude/rules.md / .claude/rules/ / .claude/commands/ / .claude/agents/ /
# .claude/skills/）の正本は tool-template。子リポ（git remote が tool-template 以外）では
# これらへの Write/Edit をブロックし、改善提案は docs/evolution-log.md へ誘導する。
# ※Bash 経由の書込は対象外＝事故防止であって完全強制ではない。
#
# fail-closed 方針（block-dangerous-git.sh と同型）:
#   - jq 不在 → exit 2（入力を解析できない保護 hook は素通りさせない）
#   - stdin JSON の parse 失敗 → exit 2
#   - matcher 対象（Edit|MultiEdit|Write|NotebookEdit）なのに対象パスが空 → exit 2
#     （対象パスを特定できない書込は保護判定不能のため通さない）
# .disable-hooks エスケープは維持。
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。
if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

# jq 依存 — 保護 hook なので fail-closed
if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: 'jq' is required by the sensitive-file protection hook but not found in PATH" >&2
  exit 2
fi

INPUT=$(cat)
# Edit/MultiEdit/Write は file_path、NotebookEdit は notebook_path が正。path は防御的フォールバック
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // empty' 2>/dev/null)
JQ_RC=$?
if [ "$JQ_RC" -ne 0 ]; then
  echo "BLOCKED: malformed JSON input to sensitive-file protection hook (jq exit=$JQ_RC)" >&2
  exit 2
fi
if [ -z "$FILE_PATH" ]; then
  # matcher(Edit|MultiEdit|Write|NotebookEdit) の対象ツールは必ず file_path/notebook_path を持つ。空 = 入力異常 → fail-closed
  echo "BLOCKED: could not extract file_path from tool input (fail-closed)" >&2
  exit 2
fi

# ---- 既存保護（維持）----
PROTECTED=(".env.production" ".env.local" ".claude/hooks/" ".claude/settings.json")
for pattern in "${PROTECTED[@]}"; do
  if echo "$FILE_PATH" | grep -qF "$pattern"; then
    echo "BLOCKED: '$FILE_PATH' は保護されたファイルです。" >&2
    exit 2
  fi
done

# ---- ルール正本ガード ----
# パターンは必ず『.claude/』アンカー付き（src/commands/ 等の誤爆防止）
if echo "$FILE_PATH" | grep -qE '(^|/)\.claude/(rules\.md$|rules/|commands/|agents/|skills/)'; then
  # git 呼び出しは1回のみ（該当パスの時だけ実行）
  REMOTE_URL=$(git -C "$CLAUDE_PROJECT_DIR" remote get-url origin 2>/dev/null)
  # remote 未設定（新規リポ setup 中）は fail-open(allow)
  if [ -n "$REMOTE_URL" ]; then
    # SSH（git@host:org/repo.git）/ HTTPS / ssh:// / .git・末尾スラッシュ有無を正規化してリポ名を抽出
    REPO_NAME=$(printf '%s' "$REMOTE_URL" | sed -E 's#/+$##; s#\.git$##; s#.*[/:]##')
    if [ "$REPO_NAME" != "tool-template" ]; then
      echo "BLOCKED: '$FILE_PATH' — このファイルの正本は tool-template。" >&2
      echo "  → 改善提案は docs/evolution-log.md へ書き、tool-template に PR せよ。" >&2
      exit 2
    fi
  fi
fi
exit 0
