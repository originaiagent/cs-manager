#!/bin/bash
# evidence-check.sh — Stop hook（エビデンス URL 実在検査。goal-gate から分離した独立 hook）
# 最終 assistant メッセージが完了報告キーワードを含む時のみ発動する。
#
# 検査: メッセージ中の http(s) URL 最大5件を curl -sI で機械検査
#   プレースホルダ(example.com 等)      → exit 2（捏造検出）
#   名前解決不能・接続不能               → exit 2（捏造疑い）
#   401/403/404（認証つきURLの可能性）  → 警告のみ exit 0（誤ブロック回避）
#   5xx                                  → 警告のみ
#   localhost/127.0.0.1                  → dev エビデンスとして許容（チェック skip）
#
# 注: push-gate のテスト未検証フラグ検査は本 hook から stop-test-gate.sh へ移管済み
# （P2-C: Stop hook は並列実行のため、テスト完走によるフラグ解除と検査を同一 hook 内で
#   直列化しないと stale フラグを読む誤ブロックのレースが起きる。責務は単一オーナー化）。
# 子リポへは sync-template 経由で配布されるため、tool-template 側のみで編集すること。

export LANG=ja_JP.UTF-8
export LC_ALL=ja_JP.UTF-8

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$HOOK_DIR/lib/gate_common.sh" ]; then
  echo "[Evidence Check] WARN: lib/gate_common.sh 不在のため検査をスキップ" >&2
  exit 0
fi
# shellcheck source=lib/gate_common.sh
source "$HOOK_DIR/lib/gate_common.sh"

gc_exit_if_disabled

INPUT=$(cat)
gc_exit_if_stop_active "$INPUT"   # 再入ガード（parser 不在でも grep で先に評価）
# ここから transcript 解析が必要 → jq/node どちらも無ければ fail-closed（9周目P2-A。
# 旧実装の「jq 不在 → WARN + skip」は fail-open だったため廃止）
gc_require_json_parser

TRANSCRIPT=$(gc_input_field "$INPUT" transcript_path)
LAST=$(gc_last_assistant_message "$TRANSCRIPT")
if [ -z "$LAST" ] || [ "$LAST" = "null" ]; then exit 0; fi

# report_package はセッション報告ファイルに書かれる運用（reporting.md）。
# evidence_urls がファイル側にある場合も URL 実在検査が効くよう、検査②の URL 抽出源に
# 報告ファイル本文を加える（本文の完了主張キーワード判定・自己申告検出は $LAST のまま）。
REPORT_FILE=""
if declare -f gc_session_report_file >/dev/null 2>&1; then REPORT_FILE=$(gc_session_report_file "$INPUT"); fi
REPORT_BODY=""
if [ -n "$REPORT_FILE" ] && [ -f "$REPORT_FILE" ]; then
  REPORT_BODY=$(cat "$REPORT_FILE" 2>/dev/null)
fi

# ============================================================================
# 検査①: 動作確認コマンドの実行実績（S-1 機械裏取り・完了主張時のみ）
# ============================================================================
# 完了主張（gc_is_done_claim: 完了キーワード or report_package status=done）なのに、
# このセッションの transcript に検証系コマンドの tool_use 実績が1件も無ければ block する
# （「検証したと言うが実行していない」虚偽完了の構造的防止）。キーワード無しの
# status=done も捕捉するため、下の報告キーワード早期 return より前で判定する。
# サブエージェント（isSidechain）の実行も実績として数える（verifier 委譲を妨げない）。
# grep ベースの補助ゲート（文面遵守が一次）: Write 内容の "curl " 等による偽陽性通過は
# 許容し、正当な完了を止める偽ブロックを避ける側に倒す。JSONL は compact / 空白あり
# 両形式を許容（"key": "value" 形も対象）。
if declare -f gc_is_done_claim >/dev/null 2>&1 && gc_is_done_claim "$LAST" "$REPORT_BODY"; then
  # 開示エスケープ（理由必須）: 実行できない性質の変更（ドキュメントのみ等）
  if ! printf '%s\n' "$LAST" | grep -qE '動作確認対象外[:：][[:space:]]*[^[:space:]]'; then
    # 走査対象 = メイン transcript + サブエージェント transcript（<transcript>/subagents/ 配下）。
    # サブエージェントの実行記録は「同一ファイルの isSidechain 行」の版と「別ファイル」の版が
    # あるため両方を見る（別ファイルを見ないと verifier 委譲が偽ブロックされる）。
    # 各シグネチャは grep -q の最初のヒットで即終了（大きな transcript でも安価）。
    SUB_DIR="${TRANSCRIPT%.jsonl}/subagents"
    scan_evidence() { # $1 = tool_use 行に要求する ERE。ヒットで 0
      local pat="$1" f
      grep -E '"type"[[:space:]]*:[[:space:]]*"tool_use"' "$TRANSCRIPT" 2>/dev/null | grep -qE "$pat" && return 0
      if [ -d "$SUB_DIR" ]; then
        while IFS= read -r -d '' f; do
          grep -E '"type"[[:space:]]*:[[:space:]]*"tool_use"' "$f" 2>/dev/null | grep -qE "$pat" && return 0
        done < <(find "$SUB_DIR" -type f -name '*.jsonl' -print0 2>/dev/null)
      fi
      return 1
    }
    # Bash の検証コマンドシグネチャ（1箇所に集約。ランナー追加はここに1語足す）
    BASH_VERIFY_SIG='curl |wget |psql |(npm|pnpm|yarn|bun)( run)? test|npm run (e2e|smoke|verify)|npx playwright|vitest|jest|playwright|pytest|go test|cargo test|node --test|prod-smoke|bash [^"]*test|python3? [^"]*test'
    VERIFIED=0
    # (a) MCP 検証ツールの実呼び出し（ToolSearch のロード文字列と誤認しないよう name キーで判定）
    scan_evidence '"name"[[:space:]]*:[[:space:]]*"mcp__[^"]*__(execute_sql|get_logs)"' && VERIFIED=1
    # (b) ブラウザ操作ツール
    [ "$VERIFIED" -eq 0 ] && scan_evidence '"name"[[:space:]]*:[[:space:]]*"mcp__claude-in-chrome__' && VERIFIED=1
    # (c) Bash の検証コマンド
    [ "$VERIFIED" -eq 0 ] && scan_evidence "\"name\"[[:space:]]*:[[:space:]]*\"Bash\".*(${BASH_VERIFY_SIG})" && VERIFIED=1
    # (d) 検証系スキルの起動
    [ "$VERIFIED" -eq 0 ] && scan_evidence '"skill"[[:space:]]*:[[:space:]]*"(browse|qa|qa-only|benchmark|verify)"' && VERIFIED=1
    if [ "$VERIFIED" -eq 0 ]; then
      echo "[Evidence Check] BLOCK: 完了主張だが、このセッションに動作確認コマンドの実行実績が無い（curl / execute_sql / テスト実行 / ブラウザ操作等の tool_use が transcript に見つからない）。" >&2
      echo "  → 実際に動作確認コマンドを実行してから報告せよ（サブエージェントに実行させた場合も実績になる）。" >&2
      echo "  → 実行できない性質の変更（ドキュメントのみ等）は、報告に「動作確認対象外: <理由>」を明記すれば通過する。" >&2
      exit 2
    fi
  fi
fi

# 完了報告キーワード（report_package_validator.sh と同じ regex）を含む時のみ検査
if ! printf '%s\n' "$LAST" | grep -qE "$GC_REPORT_KEYWORDS"; then exit 0; fi

# ============================================================================
# 検査②: エビデンス URL 実在検査
# ============================================================================
if ! command -v curl >/dev/null 2>&1; then
  echo "[Evidence Check] WARN: curl が見つかりません。URL 実在検査をスキップ。" >&2
  exit 0
fi

# URL 抽出（ASCII の URL 文字のみにマッチさせ、日本語文が混ざるのを防止）
URL_RE='https?://[A-Za-z0-9._~:/?#@!$&*+,;=%()-]+'
URLS=$(printf '%s\n%s\n' "$REPORT_BODY" "$LAST" \
  | grep -oE "$URL_RE" \
  | sed -E 's/[.,;:!?)]+$//' \
  | awk '!seen[$0]++' \
  | head -5)
[ -z "$URLS" ] && exit 0

# ---- 内部/私設アドレスの検査除外（11周目P2-B: SSRF/内部プローブ防止）----
# 報告文はプロンプト影響下にあり得るため、内部ネットワーク宛 URL には curl を飛ばさない。
# 判定は「IP リテラル + 内部様サフィックス」の静的判定のみ。ホスト名を DNS 解決して
# 私設 IP か調べる判定（DNS rebinding 等）は本 hook の範囲外（検査自体が外部アクセスを
# 増やすため実施しない）。整数形/16進形 IP（http://2130706433/ 等）は保守側で内部扱い。
is_internal_host() {
  local h="$1"
  h="${h#[}"; h="${h%]}"   # IPv6 ブラケット除去
  case "$h" in
    localhost|*.localhost|*.local|*.internal|*.lan|*.home.arpa|*.intranet|*.corp) return 0 ;;
    ::1|::1%*|::|fe80:*|fc[0-9a-fA-F][0-9a-fA-F]:*|fd*:*) return 0 ;;  # IPv6 loopback/link-local/ULA
    0[xX]*) return 0 ;;      # 16進 IP 形式（curl は IP として解釈する）
  esac
  case "$h" in *[!0-9.]*) : ;; *)
    # 数字とドットのみ = IPv4 リテラル（または整数形 IP）
    case "$h" in
      *.*) : ;;
      *) return 0 ;;         # ドット無し整数形 IP（例 2130706433 = 127.0.0.1）
    esac
    # IPv4 特殊用途帯の網羅（22周目P2-B: RFC 6890 系。private/loopback/link-local に加え
    # CGNAT・ベンチマーク・TEST-NET・マルチキャスト・予約帯も curl 対象から除外する）
    local o1 o2 o3 rest rest2
    o1=${h%%.*}; rest=${h#*.}; o2=${rest%%.*}; rest2=${rest#*.}; o3=${rest2%%.*}
    case "$o1" in
      127|10) return 0 ;;
      0*) return 0 ;;        # 0.0.0.0/8 と 0 始まり8進形（0177.0.0.1 等）
      100) case "$o2" in 6[4-9]|7[0-9]|8[0-9]|9[0-9]|1[01][0-9]|12[0-7]) return 0 ;; esac ;;  # 100.64.0.0/10 CGNAT
      169) [ "$o2" = "254" ] && return 0 ;;
      192)
        [ "$o2" = "168" ] && return 0                      # 192.168.0.0/16 private
        [ "$o2" = "0" ] && [ "$o3" = "0" ] && return 0     # 192.0.0.0/24 特殊用途
        [ "$o2" = "0" ] && [ "$o3" = "2" ] && return 0     # 192.0.2.0/24 TEST-NET-1
        ;;
      172) case "$o2" in 1[6-9]|2[0-9]|3[01]) return 0 ;; esac ;;
      198)
        case "$o2" in 18|19) return 0 ;; esac              # 198.18.0.0/15 ベンチマーク
        [ "$o2" = "51" ] && [ "$o3" = "100" ] && return 0  # 198.51.100.0/24 TEST-NET-2
        ;;
      203) [ "$o2" = "0" ] && [ "$o3" = "113" ] && return 0 ;;  # 203.0.113.0/24 TEST-NET-3
      22[4-9]|23[0-9]) return 0 ;;   # 224.0.0.0/4 マルチキャスト
      24[0-9]|25[0-5]) return 0 ;;   # 240.0.0.0/4 予約 + 255.255.255.255
    esac
  esac
  return 1
}

# ---- パーセントデコード基盤（19周目P1: encoded 内部アドレスの SSRF 迂回対策）----
# host が %XX を含むと正規化後も encoded のまま内部判定を通過し、curl がデコード済み
# 内部アドレスへ飛ぶ。判定前に host をデコードする。デコーダは python3 → node の
# フォールバック。両方不在 or 二重エンコードでデコードしきれない場合は curl せずスキップ。
pct_decoder() {
  if command -v python3 >/dev/null 2>&1; then echo python3
  elif command -v node >/dev/null 2>&1; then echo node
  fi
}
# $1 を1回パーセントデコードして stdout。デコーダ不在は rc 1。
pct_decode_once() {
  case "$(pct_decoder)" in
    python3) printf '%s' "$1" | python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.unquote(sys.stdin.read()))' 2>/dev/null ;;
    node)    printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.replace(/%[0-9A-Fa-f]{2}/g,m=>String.fromCharCode(parseInt(m.slice(1),16)))))' 2>/dev/null ;;
    *) return 1 ;;
  esac
}

while IFS= read -r url; do
  [ -z "$url" ] && continue
  # host 抽出（12周目P1: userinfo 迂回対策）:
  #   scheme 除去 → authority 部（最初の / ? # まで）→ userinfo（最後の @ まで、
  #   user:pass@ 形含む）を全て strip → [IPv6] ブラケット対応 → port（:8080）除去。
  #   http://x@169.254.169.254/ の HOST が "x@169.254..." になり内部判定を迂回して
  #   curl が内部へ飛ぶ穴を塞ぐ。判定のみ正し、curl に渡す URL は元のまま。
  AUTH=$(printf '%s' "$url" | sed -E 's@^https?://@@; s@[/?#].*$@@')
  AUTH=${AUTH##*@}
  case "$AUTH" in
    \[*) HOST=${AUTH#[}; HOST=${HOST%%]*} ;;
    *)   HOST=${AUTH%%:*} ;;
  esac
  # host 正規化（14周目P2-B）: ホスト名は大小非区別かつ末尾ドット許容のため、
  # (1) 小文字化 (2) 末尾ドット除去 をしてから全判定（localhost/内部/プレースホルダ/
  # サフィックス）に掛ける。http://LOCALHOST:3000 や http://localhost.:3000 が
  # スキップを逃れて curl される穴を塞ぐ。IPv6 の %zone やゾーンは判定に影響しない。
  # パーセントデコード（19周目P1）: host に %XX があれば判定前にデコード（二重まで）。
  # デコード後も % が残る（三重以上）or デコーダ不在なら curl せずスキップ（内部プローブ回避）。
  case "$HOST" in
    *%*)
      DEC="$HOST"
      if D1=$(pct_decode_once "$DEC") && D2=$(pct_decode_once "$D1"); then
        DEC="$D2"
      fi
      case "$DEC" in
        *%*)
          echo "[Evidence Check] skip: host にパーセントエンコードが残る/デコード不能のため検査対象外（内部プローブ回避）: $url" >&2
          continue ;;
        *) HOST="$DEC" ;;
      esac ;;
  esac
  HOST=$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')
  while [ "${HOST%.}" != "$HOST" ]; do HOST=${HOST%.}; done

  # dev/内部エビデンスは許容（検査対象外。curl は実行しない）
  if is_internal_host "$HOST"; then
    echo "[Evidence Check] skip: 内部/ローカル様アドレスのため検査対象外（dev/内部エビデンス扱い）: $url" >&2
    continue
  fi
  # プレースホルダ検出（example.com / example.org / your-domain 等）
  if printf '%s' "$HOST" | grep -qiE '(^|\.)example\.(com|org|net)$|your-?domain|yourdomain|your_domain|placeholder'; then
    echo "[Evidence Check] BLOCK: エビデンスURLがプレースホルダ: $url" >&2
    echo "  → 実在する確認先 URL（本番URL / PR URL / スクショURL 等）に差し替えよ" >&2
    exit 2
  fi

  HTTP_CODE=$(curl -sI -o /dev/null --max-time 8 --proto '=http,https' --max-redirs 0 -w '%{http_code}' "$url" 2>/dev/null)
  CURL_RC=$?
  # curl exit code の分類（14周目P2-A）:
  #   恒久エラー → BLOCK（捏造/壊れエビデンス。再試行しても直らない）
  #     3  = URL malformed（例 http://%）
  #     6  = ホスト名解決不能
  #     7  = 接続不能
  #   一時エラー → WARN のみ通過（環境依存で偽陽性になり得る）
  #     28 = timeout / 35 = SSL handshake / その他
  case "$CURL_RC" in
    3)
      echo "[Evidence Check] BLOCK: エビデンスURLが不正な形式（URL malformed）: $url (curl exit=3)" >&2
      echo "  → 壊れた/捏造 URL の疑い。正しい確認先 URL に差し替えよ" >&2
      exit 2 ;;
    6|7)
      echo "[Evidence Check] BLOCK: エビデンスURLに到達できない（捏造疑い）: $url (curl exit=$CURL_RC)" >&2
      echo "  → 名前解決不能・接続不能。実在する URL か確認し、正しいエビデンスに差し替えよ" >&2
      exit 2 ;;
  esac
  if [ "$CURL_RC" -ne 0 ]; then
    echo "[Evidence Check] WARN: $url は curl exit=$CURL_RC（timeout/SSL 等の一時エラー）で検査未完。到達性は未確認" >&2
    continue
  fi
  case "$HTTP_CODE" in
    401|403|404)
      echo "[Evidence Check] WARN: $url → HTTP $HTTP_CODE（認証つき URL の可能性があるためブロックしない）" >&2 ;;
    5*)
      echo "[Evidence Check] WARN: $url → HTTP $HTTP_CODE（サーバエラー）" >&2 ;;
  esac
done <<< "$URLS"

exit 0
