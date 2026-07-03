#!/usr/bin/env node
/**
 * prod-smoke.mjs — 本番 URL の夜間スモークチェック（依存ゼロ・Node 20+）
 *
 * 「ローカルテスト通過 ≠ 本番で動く」の穴を機械的に塞ぐ P4-e 部品。
 * prod-smoke-nightly.yml（tool-template から全リポへ配布）が毎晩実行する。
 *
 * 動作:
 *   - env TOOL_URL のルート群を fetch（timeout 15s、redirect follow）
 *   - 検査ルートはリポ root の prod-smoke.config.json {"paths": ["/", "/dashboard"]}
 *     で opt-in 追加できる。無ければ ["/"] のみ
 *   - 5xx・404 または接続不能が 1 件でもあれば構造化 JSON を出力して exit 1
 *     （404 はルート不在 or TOOL_URL 取り違えの疑いとして FAIL 扱い）
 *   - それ以外の 200-499 は pass（401/403/429 は「認証・レート制限つきで稼働中」扱い）
 *   - TOOL_URL 未設定は SKIP で exit 0（未登録リポでの副作用ゼロ）
 *
 * Exit codes: 0 = pass / skip, 1 = fail
 */

import fs from 'node:fs';

const TIMEOUT_MS = 15_000;
const TOOL_URL = (process.env.TOOL_URL || '').trim();
const CONFIG_FILE = 'prod-smoke.config.json';

function emit(summary, { error = false } = {}) {
  const out = JSON.stringify(summary, null, 2);
  if (error) console.error(out);
  else console.log(out);
}

if (!TOOL_URL) {
  emit({
    status: 'SKIP',
    reason: 'TOOL_URL 未設定（vars.TOOL_URL を登録するとこのリポでも smoke が有効になる）',
  });
  process.exit(0);
}

// TOOL_URL の事前バリデーション: スキーム無し（example.com 等）だと new URL が
// throw して構造化 FAIL 無しの stacktrace 墜落になるため、ここで検査して
// 構造化 JSON の FAIL + exit 1 に落とす。
try {
  new URL(TOOL_URL);
} catch (e) {
  emit(
    {
      status: 'FAIL',
      reason: `invalid TOOL_URL: "${TOOL_URL}" は URL として解釈できない（https:// 等スキーム付きで指定せよ）: ${e.message}`,
      tool_url: TOOL_URL,
    },
    { error: true },
  );
  process.exit(1);
}

let paths = ['/'];
if (fs.existsSync(CONFIG_FILE)) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    emit({ status: 'FAIL', reason: `${CONFIG_FILE} が JSON.parse 不能: ${e.message}` }, { error: true });
    process.exit(1);
  }
  if (
    !Array.isArray(cfg.paths) ||
    cfg.paths.length === 0 ||
    // "//host/..." は protocol-relative URL として別ホストに解決されるため拒否
    // （任意外部リクエスト + 偽の合否を防ぐ。9周目P2-B 第1層）
    !cfg.paths.every((p) => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//'))
  ) {
    emit(
      {
        status: 'FAIL',
        reason: `${CONFIG_FILE} の paths が不正（"/" 始まりの string 非空配列が必須。"//" 始まりは別ホストに解決されるため禁止）`,
      },
      { error: true },
    );
    process.exit(1);
  }
  paths = cfg.paths;
}

async function checkPath(p) {
  const started = Date.now();
  let url = '';
  try {
    // URL 構築も try 内で行い、万一 throw しても構造化 FAIL に落とす
    const resolved = new URL(p, TOOL_URL);
    url = resolved.toString();
    // 第2層防御（9周目P2-B）: resolve 後の origin が TOOL_URL と一致しない場合は
    // fetch せずに FAIL（"/\\host" 等 WHATWG URL の backslash 正規化による
    // config 検証すり抜けもここで遮断。外部ホストへのリクエストを発生させない）
    if (resolved.origin !== new URL(TOOL_URL).origin) {
      return {
        path: p,
        url,
        ok: false,
        status: null,
        elapsed_ms: Date.now() - started,
        reason: `resolve 先が TOOL_URL と別 origin（${resolved.origin}）のため拒否。paths の値を確認せよ`,
      };
    }
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'origin-prod-smoke/1.0' },
    });
    const elapsed_ms = Date.now() - started;
    if (res.status >= 500) {
      return { path: p, url, ok: false, status: res.status, elapsed_ms, reason: `5xx 応答: ${res.status} ${res.statusText}` };
    }
    if (res.status === 404) {
      return {
        path: p,
        url,
        ok: false,
        status: 404,
        elapsed_ms,
        reason: '404 応答 = smoke 対象ルートの不在 or TOOL_URL の取り違えの疑い（ルート削除時は prod-smoke.config.json を更新せよ）',
      };
    }
    // status < 500 かつ 404 以外は稼働扱い（401/403/429 = 認証・レート制限ゲートの向こうで生きている）
    return { path: p, url, ok: true, status: res.status, elapsed_ms };
  } catch (e) {
    const cause = e?.cause?.code || e?.name || '';
    return {
      path: p,
      url,
      ok: false,
      status: null,
      elapsed_ms: Date.now() - started,
      reason: `接続不能: ${[cause, e?.message].filter(Boolean).join(' — ')}`,
    };
  }
}

const results = [];
for (const p of paths) {
  results.push(await checkPath(p));
}

const failed = results.filter((r) => !r.ok);
const summary = {
  status: failed.length > 0 ? 'FAIL' : 'PASS',
  tool_url: TOOL_URL,
  checked: results.length,
  failed: failed.length,
  results,
};

if (failed.length > 0) {
  emit(summary, { error: true });
  process.exit(1);
}
emit(summary);
process.exit(0);
