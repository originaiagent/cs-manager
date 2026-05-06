#!/usr/bin/env node
/**
 * Nightly cache-purge verification (v7 R-4/W-4 test A).
 *
 * Identification: rows are owned via `is_test_fixture BOOLEAN` +
 * `fixture_owner_tool TEXT`. We do not use slug prefixes (Core master id
 * columns are mostly INTEGER, so a prefix scheme is not portable).
 *
 * Flow:
 *   1. GET ${TOOL_URL}/_test/cache-verify with X-Internal-API-Key
 *      → record updated_at per master (val_old)
 *   2. PATCH ${CORE_API_URL}/api/internal/test-fixture/touch { tool: TOOL_NAME }
 *      → Core bumps updated_at on every row WHERE is_test_fixture = true AND
 *        fixture_owner_tool = TOOL_NAME, then pings the tool's
 *        /api/internal/revalidate
 *   3. Poll the verify endpoint up to 30s (2s interval)
 *      → assert every master's updated_at is strictly newer than val_old
 *
 * Required env vars (set as Actions vars/secrets in each tool repo):
 *   TOOL_NAME           e.g. "ec-manager"
 *   TOOL_URL            e.g. "https://ec-manager.example.com"
 *   CORE_API_URL        e.g. "https://origin-core.example.com"
 *   INTERNAL_API_KEY    shared secret with Core
 *
 * Exit codes: 0 = pass, 1 = fail. Always prints a structured JSON summary.
 */

const TOOL_NAME = process.env.TOOL_NAME;
const TOOL_URL = process.env.TOOL_URL;
const CORE_API_URL = process.env.CORE_API_URL;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

const REQUIRED_MASTERS = [
  'products',
  'product-groups',
  'product-costs',
  'product-mall-settings',
  'mall-identifiers',
  'malls',
];

function fail(message, extra = {}) {
  console.error(JSON.stringify({ status: 'FAIL', message, ...extra }, null, 2));
  process.exit(1);
}

function pass(extra = {}) {
  console.log(JSON.stringify({ status: 'PASS', ...extra }, null, 2));
  process.exit(0);
}

function requireEnv() {
  const missing = [];
  if (!TOOL_NAME) missing.push('TOOL_NAME');
  if (!TOOL_URL) missing.push('TOOL_URL');
  if (!CORE_API_URL) missing.push('CORE_API_URL');
  if (!INTERNAL_API_KEY) missing.push('INTERNAL_API_KEY');
  if (missing.length) fail(`missing required env vars: ${missing.join(', ')}`);
}

async function fetchVerify(label) {
  const url = `${TOOL_URL.replace(/\/$/, '')}/_test/cache-verify`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Internal-API-Key': INTERNAL_API_KEY },
  });
  if (res.status === 404) {
    fail(
      `verify endpoint returned 404 (${label}): "Endpoint not found or Auth failed". ` +
        `Triage: confirm /_test/cache-verify is deployed AND INTERNAL_API_KEY matches between CI and the tool.`,
      { url, status: 404 },
    );
  }
  if (!res.ok) {
    fail(`verify endpoint returned ${res.status} (${label})`, { url, status: res.status });
  }
  const body = await res.json();
  if (!Array.isArray(body.fixtures)) {
    fail(`verify endpoint returned malformed body (${label}): missing fixtures[]`, { body });
  }
  const map = new Map();
  for (const row of body.fixtures) {
    if (row.fixture_owner_tool && row.fixture_owner_tool !== TOOL_NAME) {
      fail(
        `verify endpoint returned fixture owned by ${row.fixture_owner_tool} (expected ${TOOL_NAME}). ` +
          `This means the tool is reading other tools' fixtures — race-condition risk.`,
        { row },
      );
    }
    map.set(row.master, row);
  }
  for (const master of REQUIRED_MASTERS) {
    if (!map.has(master)) {
      fail(`verify endpoint missing master "${master}" (${label})`, { masters: [...map.keys()] });
    }
  }
  return map;
}

async function touchCore() {
  const url = `${CORE_API_URL.replace(/\/$/, '')}/api/internal/test-fixture/touch`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-API-Key': INTERNAL_API_KEY,
    },
    body: JSON.stringify({ tool: TOOL_NAME }),
  });
  if (!res.ok) {
    fail(`Core touch endpoint returned ${res.status}`, { url, status: res.status });
  }
}

function diff(oldMap, newMap) {
  const stale = [];
  for (const master of REQUIRED_MASTERS) {
    const oldRow = oldMap.get(master);
    const newRow = newMap.get(master);
    if (!oldRow || !newRow) {
      stale.push({ master, reason: 'missing_row' });
      continue;
    }
    if (oldRow.id !== newRow.id) {
      stale.push({ master, reason: 'id_changed', old_id: oldRow.id, new_id: newRow.id });
      continue;
    }
    const oldT = oldRow.updated_at ? Date.parse(oldRow.updated_at) : NaN;
    const newT = newRow.updated_at ? Date.parse(newRow.updated_at) : NaN;
    if (Number.isNaN(newT) || Number.isNaN(oldT) || newT <= oldT) {
      stale.push({ master, old: oldRow.updated_at, current: newRow.updated_at });
    }
  }
  return stale;
}

async function main() {
  requireEnv();
  console.log(`[cache-purge-verify] tool=${TOOL_NAME} url=${TOOL_URL}`);

  const valOld = await fetchVerify('pre-touch');
  console.log('[cache-purge-verify] captured pre-touch updated_at values');

  await touchCore();
  console.log('[cache-purge-verify] core touch sent');

  const start = Date.now();
  let lastStale = null;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const valNew = await fetchVerify('poll');
    const stale = diff(valOld, valNew);
    if (stale.length === 0) {
      pass({
        elapsed_ms: Date.now() - start,
        masters: REQUIRED_MASTERS,
      });
    }
    lastStale = stale;
    console.log(
      `[cache-purge-verify] still stale: ${stale.map((s) => s.master).join(',')} ` +
        `(${Math.round((Date.now() - start) / 1000)}s)`,
    );
  }

  fail(`cache purge did not propagate within ${POLL_TIMEOUT_MS / 1000}s`, {
    stale: lastStale,
  });
}

main().catch((err) => fail(`unhandled error: ${err?.message ?? err}`, { stack: err?.stack }));
