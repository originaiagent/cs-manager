#!/bin/bash
# 危険な git / shell 操作をブロックする pre-tool-use hook (shell words tokenize 方式, A+ 版)
#
# Tom 決定 (2026-05-15):
#   - git branch -D は ALLOW (reflog で復旧可能、ローカル削除は重大でない)
#   - --force-with-lease / --force-if-includes は ALLOW (安全な force-push 代替)
#   - rm -rf の保護を /, ., *, ~, $VAR, ./, ../ まで拡大
#   - +<refspec> 形式の force push を BLOCK
#   - command / sudo / time / env / --no-pager / -C path 等を統合検出
#   - jq 失敗時は fail-closed
#
# 既知の制限 (follow-up PR で対応予定):
#   - shell quote bypass: `git push "--force"` / `rm "-rf" /` のような quote 付き形式は
#     read -ra が POSIX shell tokenizer でないため bypass される。python3 shlex への
#     移行を検討中。
#   - `&` background separator、quote 内 `;` / `||` の誤分割（split_segments quote 非対応）
#   - `git -c alias.x='push -f' x` のような alias 経由
#
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。

if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

# jq 依存 — security hook なので fail-closed
if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: 'jq' is required by the git safety hook but not found in PATH" >&2
  exit 2
fi

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
JQ_RC=$?
if [ $JQ_RC -ne 0 ]; then
  echo "BLOCKED: malformed JSON input to git safety hook (jq exit=$JQ_RC)" >&2
  exit 2
fi
if [ -z "$COMMAND" ]; then exit 0; fi

# CLAUDE_PROJECT_DIR の HEAD ブランチ (main/master 直接 push 防止用)
BRANCH=$(cd "$CLAUDE_PROJECT_DIR" 2>/dev/null && git symbolic-ref --short HEAD 2>/dev/null || echo "")

block() {
  echo "BLOCKED: $1: '$COMMAND'" >&2
  exit 2
}

# 任意 token が「short option cluster で flag-char を含む」かを判定 (--long は除外)
has_short_flag() {
  local flag="$1"; shift
  local t
  for t in "$@"; do
    case "$t" in
      --*) continue ;;
      -*"$flag"*) return 0 ;;
    esac
  done
  return 1
}

# token に exact match (空白区切り)
has_token() {
  local needle="$1"; shift
  local t
  for t in "$@"; do [ "$t" = "$needle" ] && return 0; done
  return 1
}

check_rm() {
  # rf (任意 cluster: -rf / -Rf / -fr / -fR / -rfv 等) 検出時に危険パスをブロック
  has_short_flag r "$@" || has_short_flag R "$@" || has_token --recursive "$@" || return 0
  has_short_flag f "$@" || has_token --force "$@" || return 0

  local t
  for t in "$@"; do
    case "$t" in
      -*) continue ;;
      '/') block "rm -rf /" ;;
      '.'|'./') block "rm -rf . (current directory)" ;;
      '*') block "rm -rf * (glob, whole CWD)" ;;
      '~'|'~/') block "rm -rf ~ (home)" ;;
      '..'|'../') block "rm -rf .. (parent directory)" ;;
      '../'*) block "rm -rf ../<path> (parent traversal)" ;;
      '$'*) block "rm -rf <unexpanded \$VAR>" ;;
      '"$'*) block "rm -rf <unexpanded \"\$VAR\">" ;;
    esac
  done
}

check_git_sub() {
  local sub="$1"; shift
  case "$sub" in
    push)
      # ALLOW: --force-with-lease, --force-if-includes
      # BLOCK: --force / -f / --mirror / --delete / -d / refspec ":<ref>" / "+<refspec>"
      local t
      for t in "$@"; do
        case "$t" in
          --force-with-lease|--force-with-lease=*) continue ;;
          --force-if-includes) continue ;;
          --force|--force=*) block "git push --force" ;;
          --mirror) block "git push --mirror" ;;
          --delete) block "git push --delete" ;;
          :*) block "git push :<ref> (remote delete syntax)" ;;
          +*) block "git push +<refspec> (force push without --force)" ;;
        esac
      done
      has_short_flag f "$@" && block "git push -f (short, possibly clustered like -uf)"
      has_short_flag d "$@" && block "git push -d (= --delete short form)"
      ;;
    reset)
      has_token --hard "$@" && block "git reset --hard"
      ;;
    clean)
      has_token --force "$@" && block "git clean --force"
      has_short_flag f "$@" && block "git clean -f (possibly -fd / -fdx)"
      ;;
    checkout)
      has_token -- "$@" && block "git checkout -- (discard working tree changes)"
      ;;
    stash)
      has_token drop "$@" && block "git stash drop"
      has_token clear "$@" && block "git stash clear"
      ;;
    # branch -D / restore は Tom 決定で現状ノータッチ
  esac
}

check_gcloud() {
  [ "$1" = "run" ] && [ "$2" = "deploy" ] || return 0
  has_token --source "$@" && block "gcloud run deploy --source"
  local t
  for t in "$@"; do
    case "$t" in
      --source=*) block "gcloud run deploy --source=<path>" ;;
    esac
  done
}

check_segment() {
  local seg="$1"
  # ltrim / rtrim
  seg="${seg#"${seg%%[![:space:]]*}"}"
  seg="${seg%"${seg##*[![:space:]]}"}"
  [ -z "$seg" ] && return 0

  local -a tokens
  read -ra tokens <<<"$seg"
  [ ${#tokens[@]} -eq 0 ] && return 0

  # ---- wrapper を順次剥がす (command / exec / time / sudo / env / builtin) ----
  while [ ${#tokens[@]} -gt 0 ]; do
    case "${tokens[0]}" in
      command|exec|builtin)
        tokens=("${tokens[@]:1}") ;;
      time)
        tokens=("${tokens[@]:1}")
        [ ${#tokens[@]} -gt 0 ] && [ "${tokens[0]}" = "-p" ] && tokens=("${tokens[@]:1}")
        ;;
      sudo)
        tokens=("${tokens[@]:1}")
        # sudo の option / env assignment を skip
        while [ ${#tokens[@]} -gt 0 ]; do
          case "${tokens[0]}" in
            # long-option space-form (次 token が値): codex B-6-3 #1
            --user|--group|--host|--prompt|--chdir|--login-class|--type|--role) tokens=("${tokens[@]:2}") ;;
            # long-option = 形式 (1 token)
            --user=*|--group=*|--host=*|--prompt=*|--chdir=*|--login-class=*|--type=*|--role=*) tokens=("${tokens[@]:1}") ;;
            # short option (2-token form: -u user / -g group / ...)
            -u|-g|-p|-h|-r|-t|-U|-D|-T) tokens=("${tokens[@]:2}") ;;
            # 終端
            --) tokens=("${tokens[@]:1}"); break ;;
            # env assignment (sudo は command 前の VAR=val を受け付ける): codex B-6-3 #2
            *=*) tokens=("${tokens[@]:1}") ;;
            # その他の short / long option (-n, -A, -E, -H, -i, -K, -k, -l, -L, -P, -S, -s, -V, -v, --non-interactive 等)
            -*) tokens=("${tokens[@]:1}") ;;
            *) break ;;
          esac
        done
        ;;
      env)
        tokens=("${tokens[@]:1}")
        # env VAR=val ... command の VAR=val を skip
        while [ ${#tokens[@]} -gt 0 ]; do
          case "${tokens[0]}" in
            *=*) tokens=("${tokens[@]:1}") ;;
            -u) tokens=("${tokens[@]:2}") ;;
            --) tokens=("${tokens[@]:1}"); break ;;
            -*) tokens=("${tokens[@]:1}") ;;
            *) break ;;
          esac
        done
        ;;
      *) break ;;
    esac
  done
  [ ${#tokens[@]} -eq 0 ] && return 0

  local prog="${tokens[0]}"

  # ---- プログラム別分岐 ----
  case "$prog" in
    rm|/bin/rm)
      check_rm "${tokens[@]:1}"
      return 0
      ;;
    gcloud)
      check_gcloud "${tokens[@]:1}"
      return 0
      ;;
    git)
      ;;  # 続けて git global option を処理
    *)
      return 0
      ;;
  esac

  # ---- git global options を skip ----
  tokens=("${tokens[@]:1}")  # remove "git"
  while [ ${#tokens[@]} -gt 0 ]; do
    case "${tokens[0]}" in
      -C|-c|--git-dir|--work-tree|--namespace|--exec-path)
        # 2-token: -C <path>
        tokens=("${tokens[@]:2}") ;;
      --git-dir=*|--work-tree=*|--namespace=*|--exec-path=*)
        tokens=("${tokens[@]:1}") ;;
      --no-pager|--paginate|-P|--no-replace-objects|--bare|--no-optional-locks|--literal-pathspecs|--version|--help)
        tokens=("${tokens[@]:1}") ;;
      *)
        break ;;
    esac
  done
  [ ${#tokens[@]} -eq 0 ] && return 0

  local sub="${tokens[0]}"
  local -a args=("${tokens[@]:1}")

  # ---- main/master 直接 push 防止 (wrapper / global option 統合後にここで判定) ----
  if [ "$sub" = "push" ] && { [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; }; then
    block "mainブランチから直接pushは禁止。claude/xxx ブランチで PR を出してください"
  fi

  # ---- git subcommand の危険オプション検出 ----
  check_git_sub "$sub" "${args[@]}"
}

# &&, ||, ;, | で sub-command 分割 (quote-aware ではない — follow-up で改善予定)
split_segments() {
  echo "$1" | sed -E 's/&&|\|\|/\n/g; s/[;|]/\n/g'
}

while IFS= read -r segment; do
  check_segment "$segment"
done < <(split_segments "$COMMAND")

exit 0
