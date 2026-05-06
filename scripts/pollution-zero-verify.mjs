#!/usr/bin/env node
/**
 * v7 R-4 / W-4 テスト B: 業務 UI 通常 URL から test-fixture 由来データが
 * 一切露出していないことを CI で機械検証する。
 *
 * 前提:
 *   - Core master 10 テーブルに is_test_fixture / fixture_owner_tool 列追加済
 *   - SDK が WHERE is_test_fixture=false をデフォルト強制適用 (フェイルセーフ)
 *   - 1/6 で test-fixture-{tool_name} 命名規則の seed 投入予定
 *
 * 動作:
 *   - リポ root の `pollution-zero.config.json` を読む
 *   - `urls` の各 URL を素の fetch (追加ヘッダなし、redirect follow) で取得
 *   - レスポンス本文に test-fixture 露出パターンが 1 件でも含まれていれば exit 1
 *
 * SKIP / ERROR 挙動:
 *   - 設定ファイル不在 → SKIP (exit 0)
 *   - urls 配列空 → SKIP (exit 0)
 *   - 取得失敗 (network / 5xx) → ERROR (exit 1)
 *   - 露出検出 → exit 1
 *
 * 設定ファイル仕様 (`pollution-zero.config.json`):
 *   {
 *     "urls": [
 *       "https://example.app/products",
 *       "https://example.app/api/products"
 *     ],
 *     "timeoutMs": 15000,         // 任意、既定 15000
 *     "extraPatterns": [           // 任意、ツール固有の追加検出パターン
 *       "internal-test-marker"
 *     ]
 *   }
 *
 * 共通の正解は SDK デフォルト (is_test_fixture=false) に従うこと。
 * アプリ側で WHERE 句を書いて除外するのは v7 失格表現。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), "pollution-zero.config.json");

if (!existsSync(CONFIG_PATH)) {
  console.log("[pollution-zero] SKIP — pollution-zero.config.json not found.");
  process.exit(0);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (e) {
  console.error(`[pollution-zero] ERROR — failed to parse pollution-zero.config.json: ${e.message}`);
  process.exit(1);
}

const URLS = Array.isArray(config.urls) ? config.urls : [];
if (URLS.length === 0) {
  console.log("[pollution-zero] SKIP — urls is empty in pollution-zero.config.json.");
  process.exit(0);
}

const TIMEOUT_MS = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 15000;
const EXTRA_PATTERNS = Array.isArray(config.extraPatterns) ? config.extraPatterns : [];

// 検出パターン (1 件でも合致すれば pollution = exit 1)
const DETECTION_PATTERNS = [
  { name: "is_test_fixture:true", regex: /"is_test_fixture"\s*:\s*true/i },
  { name: "fixture_owner_tool (non-null)", regex: /"fixture_owner_tool"\s*:\s*"[^"]+"/i },
  { name: "test-fixture- prefix", regex: /test-fixture-/i },
  ...EXTRA_PATTERNS.map((p, i) => ({ name: `extra[${i}]: ${p}`, regex: new RegExp(p) })),
];

// HTML エンティティ最低限デコード (Next.js __NEXT_DATA__ 等で escape される quote 系)
function decodeBasicEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const body = await res.text();
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, error: e };
  } finally {
    clearTimeout(timer);
  }
}

const fetchErrors = [];
const detections = [];

for (const url of URLS) {
  const result = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!result.ok) {
    fetchErrors.push({ url, message: result.error?.message ?? String(result.error) });
    continue;
  }
  if (result.status >= 500) {
    fetchErrors.push({ url, message: `HTTP ${result.status}` });
    continue;
  }
  const decoded = decodeBasicEntities(result.body);
  for (const p of DETECTION_PATTERNS) {
    const m = decoded.match(p.regex);
    if (m) {
      const idx = m.index ?? decoded.indexOf(m[0]);
      const start = Math.max(0, idx - 40);
      const end = Math.min(decoded.length, idx + m[0].length + 40);
      const snippet = decoded.slice(start, end).replace(/\s+/g, " ");
      detections.push({ url, status: result.status, pattern: p.name, match: m[0], snippet });
    }
  }
}

if (fetchErrors.length > 0) {
  console.error(`\n[pollution-zero] FETCH ERROR — ${fetchErrors.length} URL(s) failed to fetch:\n`);
  for (const e of fetchErrors) {
    console.error(`  ${e.url}\n    → ${e.message}`);
  }
}

if (detections.length > 0) {
  console.error(`\n[pollution-zero] POLLUTION DETECTED — ${detections.length} match(es):\n`);
  for (const d of detections) {
    console.error(`  ${d.url} (HTTP ${d.status})`);
    console.error(`    pattern: ${d.pattern}`);
    console.error(`    match:   ${d.match}`);
    console.error(`    context: …${d.snippet}…`);
  }
  console.error(
    `\nSDK のデフォルト除外 (is_test_fixture=false) が効いていない可能性があります。\n` +
    `アプリ側 WHERE 句で除外するのは v7 失格表現。SDK バージョンと呼び出し側の`,
  );
  console.error(`includeTestFixture オプションを確認してください。`);
}

if (fetchErrors.length > 0 || detections.length > 0) {
  process.exit(1);
}

console.log(`[pollution-zero] OK — checked ${URLS.length} URL(s), no test-fixture exposure.`);
