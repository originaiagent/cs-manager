#!/bin/bash
# load_detectors.sh — Tier 0 検出器の正本（origin-policy）取得 + キャッシュ + fallback
#
# 各 hook (policy_gate_stop.sh / question_classifier.sh / report_package_validator.sh) が
# `source` して使う共通ライブラリ。
#
# 提供関数:
#   policy_gate_yaml_path        → tier0_detectors.yaml のローカルパスを echo
#   human_judgment_yaml_path     → human_judgment_categories.yaml のローカルパスを echo
#   report_package_schema_path   → report_package.schema.json のローカルパスを echo
#   yaml_eval_python <yaml> <py> → yaml をロードし Python 式を評価、結果を改行区切りで出力
#   yaml_parser_available        → yq か python3+PyYAML が使えるか判定
#
# 取得優先順位 (live → cache → bundled fallback):
#   1. raw.githubusercontent.com から curl
#   2. 直近成功時の ~/.origin-policy-cache/ キャッシュ
#   3. 同梱 fallback (.claude/hooks/lib/fallback/)
#
# キャッシュTTL: 5分以内の取得は skip (4 hooks 連続実行時のラグ抑制)

# ============================================================================
# 設定
# ============================================================================
ORIGIN_POLICY_RAW_BASE="${ORIGIN_POLICY_RAW_BASE:-https://raw.githubusercontent.com/originaiagent/origin-policy/main}"
ORIGIN_POLICY_CACHE_DIR="${ORIGIN_POLICY_CACHE_DIR:-${HOME}/.origin-policy-cache}"
ORIGIN_POLICY_CACHE_TTL_SECONDS="${ORIGIN_POLICY_CACHE_TTL_SECONDS:-300}"
ORIGIN_POLICY_CURL_TIMEOUT="${ORIGIN_POLICY_CURL_TIMEOUT:-3}"

_LOAD_DETECTORS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_FALLBACK_DIR="${_LOAD_DETECTORS_DIR}/fallback"

mkdir -p "$ORIGIN_POLICY_CACHE_DIR" 2>/dev/null || true

# ============================================================================
# 内部: cache が新鮮か判定
# ============================================================================
_cache_is_fresh() {
  local file="$1"
  [ -f "$file" ] || return 1
  local now mtime age
  now=$(date +%s)
  if mtime=$(stat -f %m "$file" 2>/dev/null); then :;
  elif mtime=$(stat -c %Y "$file" 2>/dev/null); then :;
  else return 1; fi
  age=$(( now - mtime ))
  [ "$age" -lt "$ORIGIN_POLICY_CACHE_TTL_SECONDS" ]
}

# ============================================================================
# 内部: 1 ファイル取得 (live → cache → bundled)
# 引数: <relative_url_path> <cache_filename>
# 標準出力: 使えるローカルファイルのパス
# 失敗時: bundled もなければ exit code 1
# ============================================================================
_fetch_or_cache() {
  local rel_path="$1"
  local cache_name="$2"
  local cache_file="${ORIGIN_POLICY_CACHE_DIR}/${cache_name}"
  local bundled="${_FALLBACK_DIR}/${cache_name}"
  local url="${ORIGIN_POLICY_RAW_BASE}/${rel_path}"

  if _cache_is_fresh "$cache_file"; then
    echo "$cache_file"
    return 0
  fi

  local tmp="${cache_file}.tmp.$$"
  if command -v curl >/dev/null 2>&1 \
     && curl -fsSL --max-time "$ORIGIN_POLICY_CURL_TIMEOUT" "$url" -o "$tmp" 2>/dev/null \
     && [ -s "$tmp" ]; then
    mv -f "$tmp" "$cache_file"
    echo "$cache_file"
    return 0
  fi
  rm -f "$tmp" 2>/dev/null

  if [ -f "$cache_file" ] && [ -s "$cache_file" ]; then
    echo "[load_detectors] WARN: fetch failed, using stale cache: $cache_name" >&2
    echo "$cache_file"
    return 0
  fi

  if [ -f "$bundled" ] && [ -s "$bundled" ]; then
    echo "[load_detectors] WARN: fetch failed and no cache, using bundled fallback: $cache_name" >&2
    cp -f "$bundled" "$cache_file" 2>/dev/null || true
    echo "$bundled"
    return 0
  fi

  echo "[load_detectors] ERROR: fetch failed, no cache, no bundled fallback for $cache_name" >&2
  return 1
}

policy_gate_yaml_path() {
  _fetch_or_cache "rules/tier0_detectors.yaml" "tier0_detectors.yaml"
}

human_judgment_yaml_path() {
  _fetch_or_cache "rules/human_judgment_categories.yaml" "human_judgment_categories.yaml"
}

report_package_schema_path() {
  _fetch_or_cache "schemas/report_package.schema.json" "report_package.schema.json"
}

# ============================================================================
# Public: yaml をロードして Python 式を評価
#   引数: <yaml_path> <python_yaml_expression>
#     loaded dict は `d` で参照可能
#   出力: list/tuple は要素を改行区切り、それ以外は str(値) を 1 行
# ============================================================================
yaml_eval_python() {
  local yaml_path="$1"
  local py_expr="$2"
  python3 - "$yaml_path" "$py_expr" <<'PYEOF' 2>/dev/null
import sys, yaml
try:
    with open(sys.argv[1]) as f:
        d = yaml.safe_load(f)
    result = eval(sys.argv[2], {"d": d})
    if isinstance(result, (list, tuple)):
        for item in result:
            print(item)
    else:
        print(result)
except Exception as e:
    sys.stderr.write(f"[yaml_eval_python] {e}\n")
    sys.exit(1)
PYEOF
}

yaml_parser_available() {
  # 実装で実際に使うのは python3 + PyYAML のみ。
  # yq は手動デバッグ用 CLI として docs に記載しているが、
  # ここでは利用しないので check に含めない（誤検出回避）。
  command -v python3 >/dev/null 2>&1 && python3 -c "import yaml" 2>/dev/null
}
