#!/bin/bash
# gate_common.sh — gate 系 hook の共通関数・共通定義
#
# 新規 hook（session-start-brief / goal-reminder / goal-gate-stop / evidence-check /
# push-gate / delegate-nudge）から source される。既存 hook では stop-test-gate.sh のみ流用。
#
# 使い方:
#   HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$HOOK_DIR/lib/gate_common.sh"
#
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。

# 完了主張キーワード（stop-test-gate のテスト強制トリガ。報告全般より狭い。
# 「Done条件」は説明文でも出る語＝完了主張ではないため含めない。
# regex は macOS(BSD grep)/Linux 差を避け \s でなく [[:space:]] を使う）
# shellcheck disable=SC2034
GC_DONE_KEYWORDS='完了報告|完遂報告|完了しました|✅[[:space:]]*完了|完了です'
# 報告キーワード regex（report_package_validator / evidence-check / goal-gate /
# stop-test-gate の発火用。validator は REPORT_KEYWORDS="$GC_REPORT_KEYWORDS" で
# ここを単一ソースとする＝二重定義禁止）
# shellcheck disable=SC2034
GC_REPORT_KEYWORDS="${GC_DONE_KEYWORDS}|report_package|Done[[:space:]]*条件|進捗報告"

# .disable-hooks エスケープ（全 hook 共通）
gc_exit_if_disabled() {
  if [ -f "$CLAUDE_PROJECT_DIR/.disable-hooks" ]; then exit 0; fi
}

# ---- JSON parser 基盤（9周目P2-A: jq → node フォールバック） ----
# jq 不在マシンで transcript 解析が空になり keyword gate が静かに素通りする穴を塞ぐ。
# 方針: jq 優先 / 無ければ node -e / 両方無ければ「解析が必要になった時点」で
# gc_require_json_parser が fail-closed（exit 2）する。

# 利用可能な JSON parser 名を返す（jq / node / 空）
gc_json_parser() {
  if command -v jq >/dev/null 2>&1; then echo jq
  elif command -v node >/dev/null 2>&1; then echo node
  fi
}

# transcript / stdin JSON の解析が必要になった時点で呼ぶ fail-closed ガード
gc_require_json_parser() {
  if [ -z "$(gc_json_parser)" ]; then
    echo "[gate] BLOCK: JSON parser 不在（jq/node）。brew install jq（または apt install jq）せよ。解析不能のままゲートは素通りさせない（fail-closed）。" >&2
    exit 2
  fi
}

# JSON 文字列 ($1) から dotted path ($2 例: "transcript_path" / "blocking_question.category")
# の値を取り出す（無ければ空。object/array は compact JSON で返す）。jq → node フォールバック。
gc_input_field() {
  local json="$1" field="$2"
  case "$(gc_json_parser)" in
    jq)
      printf '%s' "$json" | jq -r --arg f "$field" \
        '(getpath($f / ".") // empty) | if type == "object" or type == "array" then tojson else tostring end' 2>/dev/null
      ;;
    node)
      printf '%s' "$json" | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
          try {
            let v = JSON.parse(d);
            for (const k of process.argv[1].split(".")) {
              if (v == null) return;
              v = v[k];
            }
            if (v === undefined || v === null || v === false) return;
            process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));
          } catch (e) {}
        });
      ' "$field" 2>/dev/null
      ;;
  esac
}

# stdin JSON ($1) の stop_hook_active が true なら exit 0（Stop hook 再入ガード）
# parser 不在時も grep で再入ガードだけは評価する（無限ループ防止。
# fail-closed は解析が必要になった時点で gc_require_json_parser が担う）
gc_exit_if_stop_active() {
  if [ -z "$(gc_json_parser)" ]; then
    if printf '%s' "$1" | grep -qE '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
      exit 0
    fi
    return 0
  fi
  if [ "$(gc_input_field "$1" stop_hook_active)" = "true" ]; then
    exit 0
  fi
}

# transcript ($1) から「最終 assistant ターンの全 text」を連結して stdout へ。
#
# 実 Claude Code transcript では 1 ターンが content ブロック単位で複数の assistant
# jsonl エントリに分割される（thinking / text / tool_use が各 n:1 の別エントリ）。
# 旧実装は「最後の 1 assistant エントリ」の text しか見ず、行頭に「🛑中断」等を書いた
# text が別（先頭側）エントリにあると取り逃していた（goal-gate が中断を認識せず BLOCK）。
#
# 修正: 末尾から遡り、メインスレッド（isSidechain!=true）の assistant エントリの
# text ブロック（thinking/tool_use 除外）を、直前の「実ユーザー入力ターン」境界まで
# 全て収集して自然順で連結する。境界 = 非 sidechain の user エントリで content が
# 文字列 or text ブロックを含むもの（tool_result のみの user はターン内なので跨ぐ）。
# jq → node フォールバック。逆順走査 + 先頭 400 行（分割で行数が増えるため 200→400）。
gc_last_assistant_message() {
  local transcript="$1"
  if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then
    return 0
  fi
  local reverse
  if command -v tac >/dev/null 2>&1; then reverse="tac"; else reverse="tail -r"; fi
  case "$(gc_json_parser)" in
    jq)
      # 入力は逆順（新しい行が先頭）。reduce で境界まで text を収集し、最後に自然順へ。
      $reverse "$transcript" 2>/dev/null | head -400 | jq -rs '
        reduce .[] as $e ({done:false, texts:[]};
          if .done then .
          else
            ($e.isSidechain == true) as $side
            | if ($e.type == "user") and ($side | not) then
                ($e.message.content) as $c
                | if ($c | type) == "string" then .done = true
                  elif ($c | type) == "array"
                       and ([$c[] | select(.type == "text")] | length > 0) then .done = true
                  else . end
              elif ($e.type == "assistant") and ($side | not) then
                .texts += ((($e.message.content // [])
                            | map(select(.type == "text") | .text)) | reverse)
              else . end
          end
        )
        | .texts | reverse | join("\n")
      ' 2>/dev/null
      ;;
    node)
      $reverse "$transcript" 2>/dev/null | head -400 | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
          const texts = [];
          let done = false;
          for (const line of d.split("\n")) {
            if (done) break;
            if (!line.trim()) continue;
            let o;
            try { o = JSON.parse(line); } catch (e) { continue; }
            const side = o && o.isSidechain === true;
            if (o && o.type === "user" && !side) {
              const c = o.message && o.message.content;
              if (typeof c === "string") { done = true; }
              else if (Array.isArray(c) && c.some((b) => b && b.type === "text")) { done = true; }
              // tool_result のみの user はターン内なので跨ぐ
            } else if (o && o.type === "assistant" && !side) {
              const c = (o.message && o.message.content) || [];
              const t = (Array.isArray(c) ? c : [])
                .filter((b) => b && b.type === "text")
                .map((b) => b.text);
              // 入力は逆順。自然順復元のため末尾から push（後で全体 reverse）
              for (let i = t.length - 1; i >= 0; i--) texts.push(t[i]);
            }
          }
          texts.reverse();
          process.stdout.write(texts.join("\n"));
        });
      ' 2>/dev/null
      ;;
  esac
}
# package.json（cwd）の .scripts[$1] を返す（string のみ。jq → node フォールバック）
gc_pkg_script() {
  case "$(gc_json_parser)" in
    jq)
      jq -r --arg k "$1" '.scripts[$k] // empty' package.json 2>/dev/null
      ;;
    node)
      node -e '
        try {
          const p = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
          const v = (p.scripts || {})[process.argv[1]];
          if (typeof v === "string") process.stdout.write(v);
        } catch (e) {}
      ' "$1" 2>/dev/null
      ;;
  esac
}

# stdin のテキスト（```json fence 抽出後など）から、key ($1) を非 null で持つ
# 最初の JSON object を compact JSON で返す（jq → node フォールバック。
# node 経路は fence 内単一 object の典型形のみ対応 = 保守側）
gc_first_json_with_key() {
  case "$(gc_json_parser)" in
    jq)
      jq -cs --arg k "$1" '.[] | select(type == "object" and .[$k] != null)' 2>/dev/null | head -n 1
      ;;
    node)
      node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
          try {
            const v = JSON.parse(d);
            if (v && typeof v === "object" && v[process.argv[1]] != null) {
              process.stdout.write(JSON.stringify(v));
            }
          } catch (e) {}
        });
      ' "$1" 2>/dev/null
      ;;
  esac
}

# 最終メッセージ ($1) が「完了主張」なら 0 を返す:
#   GC_DONE_KEYWORDS マッチ、または fence 内 report_package（schema_version +
#   task_package_id で同定した最初の JSON）の status=done。
# stop-test-gate.sh（テスト強制）と evidence-check.sh（動作確認実績ゲート）が共用する
# 単一ソース。見出し・キーワード無しの素 JSON 完了主張もここで捕捉される。
gc_is_done_claim() {
  local last="$1" report="${2:-}" fence rp tpid status
  if printf '%s\n' "$last" | grep -qE "$GC_DONE_KEYWORDS"; then return 0; fi
  # セッション報告ファイル本文（$2）が status=done の report_package でも完了主張とみなす
  # （見出し・キーワード無しの file-only 完了報告がゲートを素通りする穴を塞ぐ）。
  if [ -n "$report" ]; then
    rp=$(printf '%s\n' "$report" | gc_first_json_with_key schema_version)
    if [ -n "$rp" ]; then
      tpid=$(gc_input_field "$rp" task_package_id)
      status=$(gc_input_field "$rp" status)
      [ -n "$tpid" ] && [ "$tpid" != "null" ] && [ "$status" = "done" ] && return 0
    fi
  fi
  fence=$(printf '%s\n' "$last" | awk '
    /^[[:space:]]*```json[[:space:]]*$/ { in_block=1; next }
    /^[[:space:]]*```[[:space:]]*$/ && in_block==1 { in_block=0; next }
    in_block==1 { print }
  ')
  [ -z "$fence" ] && return 1
  rp=$(printf '%s\n' "$fence" | gc_first_json_with_key schema_version)
  [ -z "$rp" ] && return 1
  tpid=$(gc_input_field "$rp" task_package_id)
  status=$(gc_input_field "$rp" status)
  [ -n "$tpid" ] && [ "$tpid" != "null" ] && [ "$status" = "done" ]
}

# セッション報告ファイル: 完了報告の report_package JSON をトム可視の会話から分離する受け渡し先。
# 会話に貼らず .claude/.session/report-<session_id>.json に書く（reporting.md）。
# validator / evidence-check がここを読む。入力 JSON ($1, Stop hook stdin) から
# session_id を取り、ファイルパスを返す（session_id 空なら空を返す）。
gc_session_report_file() {
  local sid
  sid=$(gc_sanitize_id "$(gc_input_field "$1" session_id)")
  [ -z "$sid" ] && return 0
  printf '%s/.claude/.session/report-%s.json\n' "$CLAUDE_PROJECT_DIR" "$sid"
}

# POSIX 互換のパスハッシュ（md5sum は Linux 限定のため cksum を使用。macOS/Linux 両対応）
gc_path_hash() {
  printf '%s' "$1" | cksum | awk '{print $1}'
}

# session_id の sanitize（/tmp カウンタ・.claude/.session ファイル名キー用）
gc_sanitize_id() {
  printf '%s' "$1" | tr -cd 'A-Za-z0-9_-'
}

# push-gate.sh が timeout fail-open 時に設置する「テスト未検証」フラグのパス。
# push-gate.sh / evidence-check.sh のインライン組み立て
# （/tmp/claude_push_test_unverified_$(gc_path_hash "$CLAUDE_PROJECT_DIR")）と
# 完全一致を維持すること。
gc_push_unverified_flag() {
  printf '/tmp/claude_push_test_unverified_%s\n' "$(gc_path_hash "$CLAUDE_PROJECT_DIR")"
}

# テストが完走（pass/fail 問わず、timeout でない実行完了）した時に呼び、
# stale な「テスト未検証」フラグを解除する。
# 単一キー方式（7周目P2-B）: フラグは常に CLAUDE_PROJECT_DIR キーで書かれ、
# 本文の project= に実効 push 先リポの絶対パスを持つ。
# project= が CLAUDE_PROJECT_DIR と一致する場合のみ解除する
# （git -C 別リポ宛ての未検証は自リポのテスト成功では解消されないため残す。
#   project= 行が無い旧形式フラグは後方互換で解除する）。
gc_clear_push_unverified_flag() {
  local flag proj
  flag=$(gc_push_unverified_flag)
  [ -f "$flag" ] || return 0
  proj=$(sed -n 's/^project=//p' "$flag" 2>/dev/null | head -1)
  if [ -z "$proj" ] || [ "$proj" = "$CLAUDE_PROJECT_DIR" ]; then
    rm -f "$flag" 2>/dev/null
  fi
  return 0
}

# ---- 実行時間制限（11周目P2-A: push-gate から移設、stop-test-gate と共用） ----
# timeout のフォールバック連鎖: timeout → gtimeout → perl alarm → どれも無ければ無制限。
# （macOS 標準に timeout は無い。perl は macOS 標準搭載。perl alarm 経路では
#   alarm が exec 後も生き、SIGALRM のデフォルト動作で終了 = exit 142 として観測される）
gc_timeout_mode() {
  if command -v timeout >/dev/null 2>&1; then echo timeout
  elif command -v gtimeout >/dev/null 2>&1; then echo gtimeout
  elif command -v perl >/dev/null 2>&1; then echo perl
  fi
}

gc_run_limited() { # secs cmd...
  local secs="$1"; shift
  case "$(gc_timeout_mode)" in
    timeout)  timeout "$secs" "$@" ;;
    gtimeout) gtimeout "$secs" "$@" ;;
    perl)     perl -e 'alarm(shift @ARGV); exec @ARGV or die "exec failed: $!\n"' -- "$secs" "$@" ;;
    *)        "$@" ;;
  esac
}

# timeout 判定: 124 = timeout/gtimeout, 142 = perl alarm（SIGALRM 終了 = 128+14）
gc_is_timeout_rc() { [ "$1" -eq 124 ] || [ "$1" -eq 142 ]; }
