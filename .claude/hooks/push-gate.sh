#!/bin/bash
# push-gate.sh — PreToolUse(Bash) hook。git push 実行前の品質ゲート（型チェック+テスト）。
#
# コマンド解析は python3 shlex（punctuation_chars 有効）による引用符対応解析:
#   ① shlex でトークン化（引用符内は分割されない）
#   ② `;` `&&` `||` `|` `&` 改行・subshell括弧 等の区切り記号トークンでセグメント分割
#   ③ 各セグメントで wrapper（変数代入/command/exec/builtin/nohup/time/sudo/env）を
#      剥がした後、トークン列が `git push` で始まるか判定（git global options は skip）。
#      env -S / --split-string の引数文字列は再解析対象として収集し④と同じ再帰に掛ける。
#      ラッパー剥がしで走査可能トークンが尽きた場合は生コマンド全体を regex 判定（保険）。
#   ④ bash/sh/zsh/dash/ksh（パス形含む）+ `-c` 系オプションの文字列引数
#      （shlex が引用符を外して返す）は同じロジックで再帰解析（深さ2まで。
#      深さ超過・引用符不整合は regex 判定に落とす = 保守側）。
#      引数付きオプション（-o pipefail / 束末尾の -euo pipefail）は引数を消費して走査継続。
#   ⑤ 保険側（クラス丸ごと封鎖）: shell トークンの後続の全引数トークンに regex を
#      適用し、1つでもマッチすれば push とみなす（④のオプション走査の取り零しを吸収）
#   ※ 精密検出時は git -C 連結の実効ディレクトリも特定し、検証実行先をそのリポへ
#     切り替える（-C 先が存在しなければ exit 2 = fail-closed）。未検証フラグは常に
#     CLAUDE_PROJECT_DIR キー + 本文 project=実効リポ の単一キー方式（7周目P2-B）。
#   ⑥ 正規化隣接走査: トークン端の ` { } ( ) を strip し、任意位置で git（+global
#      options skip）の直後に push が続く並びを検出（{ git push; } / `git push` 対策）
# これにより bash -lc 'echo ok; git push' / sh -c "echo ok && git push" /
# bash -euo pipefail -c 'git push' / env -S "git push" のような迂回も検出しつつ、
# git commit -m "bash -c git push の話" のような引用文字列では誤発火しない
# （引用符内は分割されず単一トークンになるため）。
# python3 は他フック（lib/load_detectors.sh の yaml_eval_python）でも前提の環境依存。
# python3 実行失敗・不在時は保守側 fallback: 生コマンド文字列に regex
# 単語境界の git の後にどこかで単語境界の push が現れたら gate を実行する（過剰マッチ許容）。
# 方針: 誤検知（gate が余計に走る）は許容、見逃しは不可。
#
# 検証ポリシー:
#   tsc --noEmit    : 失敗→exit 2 / timeout(60s)→exit 2（fail-closed、tsc は高速なため）
#   テスト           : scripts を jq で見て明示分岐（|| 短絡イディオム禁止）。
#                      失敗→exit 2 / timeout(120s)→通過（fail-open、フリート凍結回避）。
#                      ただし timeout 時は「テスト未検証」を機械強制で可視化する:
#                        ① /tmp/claude_push_test_unverified_<path-hash> フラグを書く
#                           → Stop 側 evidence-check.sh が完了報告に『テスト未検証』の
#                             明記を要求（無ければ exit 2）。テスト完走で自動解除。
#                           フラグ書込に失敗した場合は exit 2 で push を止める
#                           （未検証状態を記録できないなら通さない = fail-closed）。
#                        ② stdout JSON の systemMessage でユーザーにも即時可視化
#                      （PreToolUse の stderr は exit 2 の時しか Claude に届かず、
#                        exit 0 の stderr は debug モード以外誰にも見えないため）
#   Python リポ      : py_compile 軽検査。失敗→exit 2
#   その他スタック   : stderr に skip を明示して通過
#
# timeout の可搬性（macOS 標準に timeout は無い）— フォールバック連鎖:
#   timeout → gtimeout → perl alarm（macOS 標準 perl で動作。SIGALRM 終了は
#   exit 142 = 128+SIGALRM(14)。124 と同様 timeout 扱い）→ どれも無ければ無制限 + stderr 警告。
#
# settings.json 側で "timeout": 180 を明示すること（デフォルト60sで hook 自体が
# kill され素通りする罠の対策）。
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi

# jq 不在時は block-dangerous-git.sh が fail-closed で全 Bash をブロックするため、
# ここで重複ブロックはしない
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

# gc_path_hash（テスト未検証フラグのパスキー）を lib から取得。
# lib 不在時は同一実装のフォールバックを定義（evidence-check.sh と一致必須）
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HOOK_DIR/lib/gate_common.sh" ]; then
  # shellcheck source=lib/gate_common.sh
  source "$HOOK_DIR/lib/gate_common.sh"
fi
if ! declare -f gc_path_hash >/dev/null 2>&1; then
  gc_path_hash() { printf '%s' "$1" | cksum | awk '{print $1}'; }
fi

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$COMMAND" ]; then exit 0; fi

# ============================================================================
# git push 検出（python3 shlex 引用符対応解析 / 失敗・不在時は regex fallback）
# ============================================================================
PUSH_DETECTED=0

# stdout に PUSH / NOPUSH の一語を返す。python 例外時は非0 + 出力なし（bash 側で fallback）
detect_push_py() {
  python3 - "$COMMAND" <<'PYEOF'
import os
import re
import shlex
import sys

SHELL_NAMES = {"bash", "sh", "zsh", "dash", "ksh"}
WRAP_SIMPLE = {"command", "exec", "builtin", "nohup"}
PUNCT_CHARS = "();<>|&\n"
SEP_CHARS = set(PUNCT_CHARS)
# 構造が取れない検出（深さ超過/引用符不整合/保険側）用の広域 regex（22周目P2-A:
# bash 側フォールバックと同一の広さ — 単語境界の git の後、どこかに単語境界の push。
# 旧: git 直後 push のみ → 3重ネスト内の `git -C ../repo push` が素通りした）。
# 過剰マッチは誤検知許容・見逃し不可の方針どおり。re.S で改行跨ぎも吸収。
GIT_PUSH_RE = re.compile(
    r"(^|[^0-9A-Za-z_])git[^0-9A-Za-z_](.*[^0-9A-Za-z_])?push([^0-9A-Za-z_]|$)", re.S
)
ASSIGN_RE = re.compile(r"^[A-Za-z_][0-9A-Za-z_]*=")
SUDO_2ARG = {"--user", "--group", "--host", "--prompt", "--chdir",
             "--login-class", "--type", "--role",
             "-u", "-g", "-p", "-h", "-r", "-t", "-U", "-D", "-T"}
# git グローバルオプション（git --help OPTIONS と突き合わせて網羅）
# 引数を別トークンで取る形（-C <path> / --config-env <n>=<env> 等）
GIT_2ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
            "--config-env", "--super-prefix", "--attr-source", "--list-cmds"}
# --opt=value 一体形
GIT_1ARG_PREFIX = ("--git-dir=", "--work-tree=", "--namespace=", "--exec-path=",
                   "--config-env=", "--super-prefix=", "--attr-source=", "--list-cmds=")
# 引数を取らないフラグ（print系 -v/-h/--html-path 等は実際は即終了するが保守側で skip 扱い）
GIT_FLAGS = {"--no-pager", "--paginate", "-P", "-p", "--no-replace-objects", "--bare",
             "--no-optional-locks", "--no-lazy-fetch", "--no-advice", "--literal-pathspecs",
             "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
             "--html-path", "--man-path", "--info-path", "--version", "--help", "-v", "-h"}
MAX_DEPTH = 2


def tokenize(s):
    lex = shlex.shlex(s, posix=True, punctuation_chars=PUNCT_CHARS)
    lex.whitespace = " \t\r"      # \n は区切り（punctuation）として扱う
    lex.whitespace_split = True
    lex.commenters = ""           # '#' コメント脱落による見逃しを防ぐ
    return list(lex)


def split_segments(tokens):
    segs, cur = [], []
    for t in tokens:
        if t and all(c in SEP_CHARS for c in t):
            if cur:
                segs.append(cur)
                cur = []
        else:
            cur.append(t)
    if cur:
        segs.append(cur)
    return segs


def base(tok):
    return tok.strip("`").rsplit("/", 1)[-1]


def strip_wrappers(toks):
    """wrapper を剥がした残りトークンと、env -S/--split-string で収集した
    再解析対象のコマンド文字列リスト、および wrapper 由来のディレクトリ変更
    （env/sudo の -C/--chdir。21周目P2）を返す。
    wdir: '' = 変更なし / <path> = リテラル合成値 / CD_UNKNOWN = 追跡不能形。"""
    sstrings = []
    wdir = ""
    i, n = 0, len(toks)
    while i < n:
        t = toks[i]
        if ASSIGN_RE.match(t):
            i += 1
            continue
        b = base(t)
        if b in WRAP_SIMPLE:
            i += 1
        elif b == "time":
            i += 1
            if i < n and toks[i] == "-p":
                i += 1
        elif b == "sudo":
            i += 1
            while i < n:
                a = toks[i]
                if a == "--":
                    i += 1
                    break
                if a in ("-D", "--chdir"):
                    # sudo のディレクトリ変更も env -C と同じ扱いで追跡（同型穴の予防）
                    if i + 1 < n:
                        v = toks[i + 1]
                        if _untrackable(v) or v == "-":
                            wdir = CD_UNKNOWN
                        elif wdir != CD_UNKNOWN:
                            wdir = compose_dir(wdir, os.path.expanduser(v))
                    i += 2
                elif a.startswith("--chdir="):
                    v = a[len("--chdir="):]
                    if _untrackable(v) or v == "-":
                        wdir = CD_UNKNOWN
                    elif wdir != CD_UNKNOWN:
                        wdir = compose_dir(wdir, os.path.expanduser(v))
                    i += 1
                elif a in SUDO_2ARG:
                    i += 2
                elif a.startswith("-") or "=" in a:
                    i += 1
                else:
                    break
        elif b == "env":
            i += 1
            while i < n:
                a = toks[i]
                if a == "--":
                    i += 1
                    break
                if a == "--split-string" or re.fullmatch(r"-[A-Za-z]*S", a):
                    # env -S: 引数文字列がコマンド列そのもの（例: env -S "git push"）
                    # なので、消費するだけでなく再解析対象として収集する
                    if i + 1 < n:
                        sstrings.append(toks[i + 1])
                    i += 2
                elif a.startswith("--split-string="):
                    sstrings.append(a[len("--split-string="):])
                    i += 1
                elif a == "--chdir" or re.fullmatch(r"-[A-Za-z]*C", a):
                    # env -C/--chdir はディレクトリ変更（21周目P2）: 単に消費すると
                    # `env -C ../other git push` が自リポ検証になるため仮想 cwd に反映。
                    # 束形（-iC 等、C が末尾で引数を取る形）も同様。
                    if i + 1 < n:
                        v = toks[i + 1]
                        if _untrackable(v) or v == "-":
                            wdir = CD_UNKNOWN
                        elif wdir != CD_UNKNOWN:
                            wdir = compose_dir(wdir, os.path.expanduser(v))
                    i += 2
                elif a.startswith("--chdir="):
                    v = a[len("--chdir="):]
                    if _untrackable(v) or v == "-":
                        wdir = CD_UNKNOWN
                    elif wdir != CD_UNKNOWN:
                        wdir = compose_dir(wdir, os.path.expanduser(v))
                    i += 1
                elif a in ("-u", "--unset"):
                    i += 2
                elif a.startswith("-") or "=" in a:
                    i += 1
                else:
                    break
        else:
            break
    return toks[i:], sstrings, wdir


def git_opts_end(toks, j):
    """toks[j:] から git global options を読み飛ばした位置を返す。"""
    n = len(toks)
    while j < n:
        t = toks[j]
        if t in GIT_2ARG:
            j += 2
        elif t.startswith(GIT_1ARG_PREFIX) or t in GIT_FLAGS:
            j += 1
        else:
            break
    return j


def is_git_push(toks):
    """wrapper 剥がし済みトークン列が git push で始まるか判定する。"""
    if not toks or base(toks[0]) != "git":
        return False
    j = git_opts_end(toks, 1)
    return j < len(toks) and toks[j].strip("`") == "push"


def _untrackable(v):
    """パス値が字句解決不能（変数展開・コマンド置換・brace）なら True。"""
    return ("$" in v) or ("`" in v) or ("{" in v) or ("}" in v)


def effective_git_dir(toks):
    """git push 確定済みトークン列（toks[0]=git）から実効ディレクトリを返す。
    git の意味論:
      - 複数 -C は順に連結（非絶対は直前基準）。これが「実行基準ディレクトリ」。
      - --work-tree があればその値（-C 適用後の基準からの相対）が検査対象リポ。
      - 無く --git-dir があればその親（<repo>/.git → <repo>）が検査対象（19周目P2-A）。
      - どちらも無ければ -C 連結値（無ければ ''）。
    値が変数展開等で字句解決不能なら CD_UNKNOWN（呼び出し側で fail-closed）。
    -C も対象切替も無ければ ''（呼び出し側で CLAUDE_PROJECT_DIR にフォールバック）。"""
    cbase = ""      # -C 連結の実行基準
    work_tree = None
    git_dir = None
    j, n = 1, len(toks)
    while j < n:
        t = toks[j]
        if t == "-C":
            if j + 1 < n:
                a = toks[j + 1]
                if _untrackable(a):
                    return CD_UNKNOWN
                if os.path.isabs(a) or not cbase:
                    cbase = a
                else:
                    cbase = os.path.join(cbase, a)
            j += 2
        elif t in ("--git-dir", "--work-tree"):
            if j + 1 < n:
                a = toks[j + 1]
                if _untrackable(a):
                    return CD_UNKNOWN
                if t == "--work-tree":
                    work_tree = a
                else:
                    git_dir = a
            j += 2
        elif t.startswith("--git-dir=") or t.startswith("--work-tree="):
            key, _, val = t.partition("=")
            if _untrackable(val):
                return CD_UNKNOWN
            if key == "--work-tree":
                work_tree = val
            else:
                git_dir = val
            j += 1
        elif t in GIT_2ARG:
            j += 2
        elif t.startswith(GIT_1ARG_PREFIX) or t in GIT_FLAGS:
            j += 1
        else:
            break
    # 対象切替（--work-tree / --git-dir）を -C 基準の上に解決
    if work_tree is not None:
        return compose_dir(cbase, work_tree)
    if git_dir is not None:
        resolved = compose_dir(cbase, git_dir)
        parent = os.path.dirname(resolved.rstrip("/")) if resolved else ""
        return parent
    return cbase


NORM_STRIP = "`{}()"


def has_adjacent_git_push(seg):
    """正規化隣接トークン走査（保険層）: 各トークン端の ` { } ( ) を strip した列で、
    任意の位置にある git（+ git global options skip）の直後に push が続けば True。
    { git push; } / echo `git push` のような brace group・コマンド置換の
    先頭一致すり抜けを塞ぐ。posix shlex は引用符内を単一トークン化するため、
    git commit -m 'git push' の引用文字列はスペース入り1トークンとなり
    ここには掛からない（誤検知しない）。"""
    toks = [t.strip(NORM_STRIP) for t in seg]
    n = len(toks)
    for i in range(n):
        if base(toks[i]) != "git":
            continue
        j = git_opts_end(toks, i + 1)
        if j < n and toks[j] == "push":
            return True
    return False


def find_c_command(toks, start):
    """toks[start] が shell 名のとき、-c の文字列引数トークンを返す（無ければ None）。"""
    saw_c = False
    i, n = start + 1, len(toks)
    while i < n:
        t = toks[i]
        if t == "--":
            i += 1
            break
        if t in ("-o", "+o", "-O", "+O"):
            i += 2
            continue
        if re.fullmatch(r"[-+][A-Za-z]+", t):
            if t.startswith("-") and "c" in t:
                saw_c = True
            if t[-1] in "oO":
                i += 2      # 束末尾の -o/-O は引数を取る（例: bash -euo pipefail -c ...）
            else:
                i += 1
            continue
        if t.startswith("--"):
            i += 1
            continue
        break
    if saw_c and i < n:
        return toks[i]
    return None


CD_UNKNOWN = "__UNKNOWN__"


def compose_dir(basedir, p):
    """仮想 cwd (basedir) にパス p を合成する（字句のみ。normpath で ./.. を解決）。"""
    if os.path.isabs(p):
        new = os.path.normpath(p)
    elif basedir:
        new = os.path.normpath(os.path.join(basedir, p))
    else:
        new = os.path.normpath(p)
    return "" if new == "." else new


# 構造が取れない検出（regex/隣接/保険）で使う cd/-C 痕跡判定（18周目P2）:
# 痕跡があれば UNKNOWN（fail-closed）、無ければ従来どおりデフォルト扱い。
CD_TRACE_RE = re.compile(
    r"(^|[^0-9A-Za-z_])(cd|pushd|popd)([^0-9A-Za-z_]|$)"
    r"|(^|[^0-9A-Za-z_])-C([^0-9A-Za-z_]|$)"
    r"|--git-dir|--work-tree|--chdir"
)


def unstructured_result(text, vcwd):
    """構造が取れない検出の実効ディレクトリ: 対象文字列に cd/-C/pushd の痕跡があれば
    CD_UNKNOWN、無ければ現在の vcwd（'' ならデフォルト = CLAUDE_PROJECT_DIR）。"""
    if vcwd == CD_UNKNOWN or CD_TRACE_RE.search(text):
        return CD_UNKNOWN
    return vcwd


def update_vcwd(vcwd, stripped):
    """セグメントが cd/pushd の単純形なら仮想 cwd を更新して返す（15周目P2、
    18周目P2 で全 depth に適用 + brace group 先頭の `{` を透過）。
    追跡可能: cd <リテラルパス> / cd（引数なし= $HOME）/ pushd <リテラルパス> /
              先頭の -P/-L/-e/-@ フラグと -- / ~ は expanduser で解決。
    追跡不能（CD_UNKNOWN を返す）: cd - / 変数展開・コマンド置換・brace展開を含む引数 /
              pushd 引数なし（スワップ）/ popd / 複数引数（CDPATH 形）。
    cd/pushd 以外のセグメントは vcwd をそのまま返す。"""
    if not stripped:
        return vcwd
    # brace group（{ cd /x; } / {cd 等）の先頭 { } を透過して cd を見つける
    i0 = 0
    while i0 < len(stripped) and stripped[i0].strip(NORM_STRIP) == "":
        i0 += 1
    if i0 >= len(stripped):
        return vcwd
    b = base(stripped[i0].strip(NORM_STRIP))
    if b == "popd":
        return CD_UNKNOWN
    if b not in ("cd", "pushd"):
        return vcwd
    if vcwd == CD_UNKNOWN:
        return CD_UNKNOWN
    args = [a for a in stripped[i0 + 1:] if a.strip(NORM_STRIP) != ""]
    i = 0
    while i < len(args) and args[i] in ("-P", "-L", "-e", "-@"):
        i += 1
    if i < len(args) and args[i] == "--":
        i += 1
    rest = args[i:]
    if len(rest) == 0:
        if b == "pushd":
            return CD_UNKNOWN
        home = os.environ.get("HOME", "")
        return home if home else CD_UNKNOWN
    if len(rest) > 1:
        return CD_UNKNOWN
    t = rest[0]
    if t == "-" or "$" in t or "`" in t or "{" in t or "}" in t:
        return CD_UNKNOWN
    return compose_dir(vcwd, os.path.expanduser(t))


def combine_nested(vcwd, r):
    """ネスト scan の結果 r（'' / パス / CD_UNKNOWN）を親の vcwd と合成する（18周目P2）。
    ネストした shell は呼び出し時点の cwd（= 親の vcwd）を継承するため、
    r が '' なら親 vcwd、相対なら親 vcwd 基準で合成、絶対はそのまま。"""
    if vcwd == CD_UNKNOWN or r == CD_UNKNOWN:
        return CD_UNKNOWN
    if r == "":
        return vcwd
    if os.path.isabs(r):
        return r
    return compose_dir(vcwd, r)


def scan(cmd, depth):
    """git push を検出したら実効ディレクトリを返す（18周目P2: 全 depth で dir 返却型）:
       ''         = 特定情報なし（最終的に CLAUDE_PROJECT_DIR で検証）
       <path>     = 実効ディレクトリ（呼び出し時 cwd 相対 or 絶対）
       CD_UNKNOWN = 追跡不能（bash 側 fail-closed）
       未検出は None。
    cd/pushd 単純形の仮想 cwd をセグメント順に追跡し（15周目P2）、push 検出時の
    実効ディレクトリ（-C 連結）と合成する。ネスト scan の結果は combine_nested で
    親の vcwd と合成して depth0 まで伝播する（bash -lc 'cd ../x && git push' 対応）。
    subshell 括弧が cd と共存する場合は括弧スコープを字句では追えないため UNKNOWN。
    push より後のセグメントの cd は影響しない（検出時点の vcwd を使用）。"""
    try:
        tokens = tokenize(cmd)
    except ValueError:
        # 引用符不整合等で解析不能 → 保守側 regex 判定（誤検知許容・見逃し不可）
        if GIT_PUSH_RE.search(cmd):
            return unstructured_result(cmd, "")
        return None
    vcwd = ""
    has_paren = any(
        t and all(c in SEP_CHARS for c in t) and ("(" in t or ")" in t)
        for t in tokens
    )
    for seg in split_segments(tokens):
        stripped, sstrings, wdir = strip_wrappers(seg)
        # 21周目P2: env/sudo の -C/--chdir はこのセグメントのコマンドの実行 cwd を
        # 変える。セグメント内の実効基準 seg_base = vcwd ∘ wdir で全判定を行う
        # （shell 自体の cwd は変わらないため vcwd の更新には含めない）。
        if vcwd == CD_UNKNOWN or wdir == CD_UNKNOWN:
            seg_base = CD_UNKNOWN
        elif wdir:
            seg_base = compose_dir(vcwd, wdir)
        else:
            seg_base = vcwd
        if is_git_push(stripped):
            if seg_base == CD_UNKNOWN:
                return CD_UNKNOWN
            cdir = effective_git_dir(stripped)
            if cdir == CD_UNKNOWN:
                return CD_UNKNOWN
            if cdir and seg_base and not os.path.isabs(cdir):
                return compose_dir(seg_base, cdir)
            if cdir:
                return cdir
            return seg_base
        # 正規化隣接トークン走査（brace group / コマンド置換 / 任意位置の git push）。
        # 構造が取れない検出のため、セグメント内に cd/-C 痕跡があれば UNKNOWN、
        # 無ければ現在の seg_base（'' = デフォルト）を返す。
        if has_adjacent_git_push(seg):
            return unstructured_result(" ".join(seg), seg_base)
        # env -S / --split-string の引数文字列は同じロジックで再帰解析
        # （再帰深さ制限は -c 再帰と共通。結果は seg_base と合成して伝播）
        for s in sstrings:
            if depth >= MAX_DEPTH:
                if GIT_PUSH_RE.search(s):
                    return unstructured_result(s, seg_base)
            else:
                r = scan(s, depth + 1)
                if r is not None:
                    return combine_nested(seg_base, r)
        # 保険: ラッパー剥がしで走査可能トークンが尽きた場合は、生コマンド全体を
        # regex 判定に落とす（オプション消費の取り零し吸収。誤検知許容・見逃し不可）
        if seg and not stripped and GIT_PUSH_RE.search(cmd):
            return unstructured_result(cmd, seg_base)
        for idx in range(len(seg)):
            if base(seg[idx]) not in SHELL_NAMES:
                continue
            # 精密側を先に: -c の文字列引数を同じロジックで再帰解析し、解決できた
            # 実効ディレクトリを seg_base と合成して伝播（18周目P2。保険側 regex を
            # 先に当てると cd 入りの -c 文字列が常に UNKNOWN になり伝播が効かない）
            arg = find_c_command(seg, idx)
            if arg is not None:
                if depth >= MAX_DEPTH:
                    if GIT_PUSH_RE.search(arg):
                        return unstructured_result(arg, seg_base)
                else:
                    r = scan(arg, depth + 1)
                    if r is not None:
                        return combine_nested(seg_base, r)
            # 保険側（クラス丸ごと封鎖）: shell トークンの後続の全引数トークンに
            # regex を適用し、1つでもマッチすれば PUSH（オプション走査の取り零し吸収）。
            # 構造が取れない検出のため cd/-C 痕跡があれば UNKNOWN。
            for rest in seg[idx + 1:]:
                if GIT_PUSH_RE.search(rest):
                    return unstructured_result(rest, seg_base)
        vcwd = update_vcwd(vcwd, stripped)
        if has_paren and vcwd:
            vcwd = CD_UNKNOWN
    return None


# 出力プロトコル: 1行目 PUSH/NOPUSH。PUSH かつ実効ディレクトリ（cd 追跡 + -C 連結、
# ネストからの伝播含む）を特定できた場合のみ2行目にそのパス。追跡不能は __UNKNOWN__
# （bash 側 fail-closed）。フラグは常に CLAUDE_PROJECT_DIR キー + 本文 project=実効リポ。
RESULT = scan(sys.argv[1] if len(sys.argv) > 1 else "", 0)
if RESULT is None:
    print("NOPUSH")
else:
    print("PUSH")
    if RESULT:
        print(RESULT)
PYEOF
}

PY_RESULT=""
if command -v python3 >/dev/null 2>&1; then
  PY_RESULT=$(detect_push_py 2>/dev/null)
fi
# 出力プロトコル: 1行目 = PUSH/NOPUSH、2行目(任意) = push の実効対象ディレクトリ（git -C 連結）
PY_STATUS=$(printf '%s\n' "$PY_RESULT" | sed -n '1p')
PUSH_TARGET_DIR=$(printf '%s\n' "$PY_RESULT" | sed -n '2p')
case "$PY_STATUS" in
  PUSH)   PUSH_DETECTED=1 ;;
  NOPUSH) PUSH_DETECTED=0 ;;
  *)
    # python3 不在 or 実行失敗 → 保守側 fallback（縮退モード）:
    # 単語境界の `git` の後、同一コマンド文字列内のどこかに単語境界の `push` が
    # 現れれば gate を実行する（13周目P2: リテラル `git push` のみ対応だと
    # `git -C ../repo push` / `git --no-pager push` が素通りするため、間に何が
    # 挟まってもマッチするまで広げた）。コミットメッセージ内の "push" 等でも
    # 発火しうる過剰マッチだが、縮退モードは誤検知許容・見逃し不可の方針
    # （正規経路は python3 が引用符・トークン境界を判別する）。改行は tr で
    # 空白に潰してから判定する（行継続コマンドの取りこぼし防止）。
    PUSH_TARGET_DIR=""
    if printf '%s' "$COMMAND" | tr '\n' ' ' | grep -qE '(^|[^[:alnum:]_])git[^[:alnum:]_](.*[^[:alnum:]_])?push([^[:alnum:]_]|$)'; then
      echo "[push-gate] WARN: python3 での解析ができないため regex fallback で push とみなす（誤検知許容・見逃し不可）。" >&2
      PUSH_DETECTED=1
      # 19周目P2-B: フォールバックは実効ディレクトリを解析できない。生コマンドに
      # cd/-C/pushd/--git-dir/--work-tree の痕跡があれば別リポ push の可能性があり、
      # 自リポ検証では別リポを未検証で通す恐れがあるため __UNKNOWN__ にして fail-closed。
      # 痕跡が無ければ従来どおり CLAUDE_PROJECT_DIR で検証（保守側）。
      if printf '%s' "$COMMAND" | tr '\n' ' ' \
         | grep -qE '(^|[^[:alnum:]_])(cd|pushd|popd)([^[:alnum:]_]|$)|(^|[^[:alnum:]_])-C([^[:alnum:]_]|$)|--git-dir|--work-tree'; then
        PUSH_TARGET_DIR="__UNKNOWN__"
      fi
    fi
    ;;
esac

[ "$PUSH_DETECTED" -eq 0 ] && exit 0

# 15周目P2: cd の追跡不能形（変数展開・コマンド置換・cd - ・subshell内cd 等）が
# push より前にある場合、python 検出器は __UNKNOWN__ を報告する。
# push 先ディレクトリを特定できない = 検証対象を選べないため fail-closed で止める。
if [ "$PUSH_TARGET_DIR" = "__UNKNOWN__" ]; then
  echo "[push-gate] BLOCK: push 先ディレクトリを特定できないため検証不能（追跡できない cd が push より前にある）。" >&2
  echo "  → cd を使わず 'git -C <path> push' を使うか、リポジトリ直下で実行せよ（fail-closed）。" >&2
  exit 2
fi

# ============================================================================
# git push 検出時のみ以下の検証を実行
# ============================================================================
# 検証対象リポの決定: python 検出器が git -C 連結の実効ディレクトリを特定した場合は
# そこへ切り替える（別リポへの push なのに自リポの tsc/test を走らせない）。
# -C 無し・shellラッパー/隣接検出などで特定不能な場合は従来どおり CLAUDE_PROJECT_DIR（保守側）。
if [ -n "$PUSH_TARGET_DIR" ]; then
  case "$PUSH_TARGET_DIR" in
    /*) PUSH_REPO_DIR="$PUSH_TARGET_DIR" ;;
    *)  PUSH_REPO_DIR="$PWD/$PUSH_TARGET_DIR" ;;   # 相対 -C は hook 起動時 cwd（=セッションcwd）基準
  esac
  if [ ! -d "$PUSH_REPO_DIR" ]; then
    echo "[push-gate] BLOCK: git -C の指す先が存在しない: $PUSH_REPO_DIR（fail-closed）。" >&2
    exit 2
  fi
  # フラグキーの一貫性のため . / .. を解決した正規パスに揃える
  PUSH_REPO_DIR=$(cd "$PUSH_REPO_DIR" 2>/dev/null && pwd)
  if [ -z "$PUSH_REPO_DIR" ]; then
    echo "[push-gate] BLOCK: git -C の指す先に cd できない（fail-closed）。" >&2
    exit 2
  fi
  cd "$PUSH_REPO_DIR" || exit 2
  # 17周目P2-B: サブディレクトリ（例 packages/web）への cd/-C からの push は
  # 「囲む git リポ全体」を push するため、検査対象（package.json/tsconfig.json 等）は
  # worktree ルートにある。rev-parse でルートを解決してそこで検査を実行する
  # （テスト未検証フラグの project= もルートで記録される）。
  # rev-parse 失敗 = push 先が git リポでない → 検証対象を特定できないため fail-closed。
  REPO_TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$REPO_TOPLEVEL" ] || [ ! -d "$REPO_TOPLEVEL" ]; then
    echo "[push-gate] BLOCK: push 先が git リポジトリでない: $PUSH_REPO_DIR（fail-closed）。" >&2
    echo "  → git リポの内側を指す 'git -C <path>' / cd 先か確認せよ。" >&2
    exit 2
  fi
  PUSH_REPO_DIR="$REPO_TOPLEVEL"
  cd "$PUSH_REPO_DIR" || exit 2
else
  PUSH_REPO_DIR="$CLAUDE_PROJECT_DIR"
  cd "$CLAUDE_PROJECT_DIR" || exit 0
fi

# テスト未検証フラグ（timeout fail-open 時に書き、Stop 側 stop-test-gate が検査）。
# 単一キー方式（7周目P2-B）: キーは常に CLAUDE_PROJECT_DIR（セッションスコープの開示義務）。
# 実効 push 先リポはフラグ本文の project= に記録する（git -C 別リポ push でも Stop 側から見える）。
UNVERIFIED_FLAG="/tmp/claude_push_test_unverified_$(gc_path_hash "$CLAUDE_PROJECT_DIR")"

# 実行時間制限は lib/gate_common.sh の gc_run_limited へ移設（11周目P2-A、
# stop-test-gate と共用）。lib 不在（sync 前の子リポ・テスト用コピー等）でも
# 動くよう、未定義時は同一実装のフォールバックを定義する（gc_path_hash と同じ流儀）。
if ! declare -f gc_run_limited >/dev/null 2>&1; then
  gc_timeout_mode() {
    if command -v timeout >/dev/null 2>&1; then echo timeout
    elif command -v gtimeout >/dev/null 2>&1; then echo gtimeout
    elif command -v perl >/dev/null 2>&1; then echo perl
    fi
  }
  gc_run_limited() {
    local secs="$1"; shift
    case "$(gc_timeout_mode)" in
      timeout)  timeout "$secs" "$@" ;;
      gtimeout) gtimeout "$secs" "$@" ;;
      perl)     perl -e 'alarm(shift @ARGV); exec @ARGV or die "exec failed: $!\n"' -- "$secs" "$@" ;;
      *)        "$@" ;;
    esac
  }
  gc_is_timeout_rc() { [ "$1" -eq 124 ] || [ "$1" -eq 142 ]; }
fi
if [ -z "$(gc_timeout_mode)" ]; then
  echo "[push-gate] WARN: timeout/gtimeout/perl いずれも不在。検証を時間制限なしで実行する。" >&2
fi
if [ -f "package.json" ]; then
  # ---- package.json 妥当性検査（fail-closed）----
  # 壊れた package.json（JSON parse 失敗）や .scripts が object でない場合、
  # 後段の jq が空を返して「テストscript無し」= fail-open に落ちる穴を塞ぐ。
  # scripts キー未定義（type = null）は正当なので従来どおり skip 側に流す。
  SCRIPTS_TYPE=$(jq -r '.scripts | type' package.json 2>/dev/null)
  JQ_RC=$?
  if [ "$JQ_RC" -ne 0 ] || [ -z "$SCRIPTS_TYPE" ]; then
    echo "[push-gate] BLOCK: package.json が不正（JSON parse 失敗）。修正してから push せよ（fail-closed）。" >&2
    exit 2
  fi
  case "$SCRIPTS_TYPE" in
    object|null) ;;
    *)
      echo "[push-gate] BLOCK: package.json が不正（.scripts が object でない: type=$SCRIPTS_TYPE）。修正してから push せよ（fail-closed）。" >&2
      exit 2 ;;
  esac

  # ---- 型チェック（timeout も exit 2 = fail-closed）----
  if [ -f "tsconfig.json" ]; then
    TSC_OUTPUT=$(gc_run_limited 60 npx tsc --noEmit 2>&1)
    TSC_RC=$?
    if gc_is_timeout_rc "$TSC_RC"; then
      echo "[push-gate] BLOCK: tscがタイムアウト（60s）。型チェックが完走しない状態での push は不可（fail-closed）。" >&2
      exit 2
    fi
    if [ "$TSC_RC" -ne 0 ]; then
      echo "[push-gate] BLOCK: 型エラーあり。修正してから push せよ:" >&2
      printf '%s\n' "$TSC_OUTPUT" | tail -n 20 >&2
      exit 2
    fi
  fi

  # ---- テスト（jq で scripts を見て明示分岐。|| 短絡イディオムは禁止）----
  TEST_AI_SCRIPT=$(jq -r '.scripts["test:ai"] // empty' package.json 2>/dev/null)
  TEST_SCRIPT=$(jq -r '.scripts.test // empty' package.json 2>/dev/null)

  TEST_CMD=""
  if [ -n "$TEST_AI_SCRIPT" ]; then
    TEST_CMD="npm run test:ai"
  elif [ -n "$TEST_SCRIPT" ]; then
    case "$TEST_SCRIPT" in
      *"no test specified"*)
        echo "[push-gate] テストscriptがnpm初期値プレースホルダのため skip" >&2 ;;
      *)
        TEST_CMD="npm test" ;;
    esac
  else
    echo "[push-gate] テストscript無し、skip" >&2
  fi

  if [ -n "$TEST_CMD" ]; then
    # shellcheck disable=SC2086
    TEST_OUTPUT=$(gc_run_limited 120 $TEST_CMD 2>&1)
    TEST_RC=$?
    if gc_is_timeout_rc "$TEST_RC"; then
      # fail-open（フリート凍結回避）。ただし「テスト未検証」を黙認しない:
      #   ① フラグファイル → Stop 側 evidence-check.sh が完了報告に『テスト未検証』の
      #      明記を要求（無ければ exit 2）。テストが完走すれば自動解除。
      #      フラグを書けない場合は fail-closed（未検証状態を記録できないなら通さない）。
      #   ② stdout JSON の systemMessage でユーザーに即時可視化
      #   （注: brace group へのリダイレクト失敗は bash 3.2 の `if !` 文脈で rc を
      #     拾えないため、simple command の printf 1発で書き、書込失敗を確実に検出する。
      #     さらに書込後の存在確認で二重に fail-closed を担保する）
      FLAG_BODY="reason=test-timeout-120s
at=$(date '+%Y-%m-%dT%H:%M:%S%z')
project=$PUSH_REPO_DIR
cmd=$TEST_CMD"
      if ! printf '%s\n' "$FLAG_BODY" > "$UNVERIFIED_FLAG" 2>/dev/null || [ ! -f "$UNVERIFIED_FLAG" ]; then
        echo "[push-gate] BLOCK: テスト未検証フラグの書込に失敗 (path: $UNVERIFIED_FLAG)。未検証状態を記録できないため push は通せない（fail-closed）。フラグパスの書込可否を確認するか、テストを完走させてから再実行せよ。" >&2
        exit 2
      fi
      echo "[push-gate] ⚠️テスト未完走(timeout 120s)。push は通すが未検証フラグを設置した: $UNVERIFIED_FLAG" >&2
      echo '{"systemMessage":"⚠️ [push-gate] テスト未完走(timeout 120s)のまま push を許可（fail-open）。完了報告と PR 本文に『テスト未検証』と明記するまで、完了報告は Stop 時に stop-test-gate がブロックする。テストを完走させれば自動解除。"}'
      exit 0
    fi
    # テストが完走した（pass/fail を問わず実行された）ので未検証フラグを解除。
    # ただし解除はフラグ本文 project= が今回の実効リポと一致する場合のみ
    # （git -C 別リポ宛ての未検証を今回の完走で握り潰さない。project= 無しの旧形式は解除）。
    if [ -f "$UNVERIFIED_FLAG" ]; then
      FLAG_PROJECT=$(sed -n 's/^project=//p' "$UNVERIFIED_FLAG" 2>/dev/null | head -1)
      if [ -z "$FLAG_PROJECT" ] || [ "$FLAG_PROJECT" = "$PUSH_REPO_DIR" ]; then
        rm -f "$UNVERIFIED_FLAG"
      fi
    fi
    if [ "$TEST_RC" -ne 0 ]; then
      echo "[push-gate] BLOCK: テスト失敗。修正してから push せよ:" >&2
      printf '%s\n' "$TEST_OUTPUT" | tail -n 20 >&2
      exit 2
    fi
  fi
  exit 0
fi

if [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; then
  PY_FILES=$(git ls-files '*.py' 2>/dev/null | head -200)
  if [ -z "$PY_FILES" ]; then
    echo "[push-gate] Pythonリポだが .py ファイル無し、skip" >&2
    exit 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[push-gate] python3 不在のため py_compile を skip" >&2
    exit 0
  fi
  PY_OUTPUT=$(printf '%s\n' "$PY_FILES" | gc_run_limited 60 xargs python3 -m py_compile 2>&1)
  PY_RC=$?
  if [ "$PY_RC" -ne 0 ]; then
    if gc_is_timeout_rc "$PY_RC"; then
      echo "[push-gate] BLOCK: py_compile がタイムアウト（60s）。" >&2
    else
      echo "[push-gate] BLOCK: py_compile 失敗。構文エラーを修正してから push せよ:" >&2
      printf '%s\n' "$PY_OUTPUT" | tail -n 20 >&2
    fi
    exit 2
  fi
  exit 0
fi

echo "[push-gate] Node/Python 以外のスタックのため検証 skip" >&2
exit 0
