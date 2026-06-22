/**
 * /api/* 統一認証 E2E (R2 設計レビュー APPROVE 済)
 *
 * 確認ケース:
 *   A. 全 method ヘッダなし → 401 (17 method ケース、12 ルートを横断)
 *   B. 間違った X-Internal-API-Key → 401 (内部 tier 代表 2 ルート)
 *   C. 正しい X-Internal-API-Key → 非 401 (200/400/404/405 のいずれか)
 *   D. cron tier: Bearer / X-Diag-Token 両 OK、wrong は 401
 *   E. diag tier: X-Diag-Token のみ OK、Bearer 不許可
 *
 * 副作用回避:
 *   - PATCH 系は存在しない UUID で 404 を期待 (認証通過 = 401 ではない の証明)
 *   - POST /api/knowledge は最小ペイロードで作成、try/finally で DELETE cleanup
 *   - draft-rag は AI 呼び出しが走るためテストでは skip 相当 (401 だけ確認)
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * env 解決順:
 *   1. .env.local (存在すれば優先): ローカル truth、他テストの process.env 汚染を回避
 *      ※ tests/unit/rakuten-cycle.spec.ts は module-load 時に
 *        process.env.INTERNAL_API_KEY を 'mock-internal-key' に上書きするため、
 *        同一 worker で動く本 spec の process.env は汚染される。.env.local 優先で吸収。
 *   2. process.env (CI / preview / Vercel で注入される運用、.env.local がない環境)
 *
 * CI で .env.local がない場合は existsSync で fallback を限定するので import 時に落ちない。
 */
function readEnvLocal(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '').replace(/\\n$/, '');
  }
  return out;
}
const envLocal = readEnvLocal();
const get = (k: string): string => (envLocal[k] ?? process.env[k] ?? '').trim().replace(/\\n$/, '');

const INTERNAL_API_KEY = get('INTERNAL_API_KEY');
const CRON_SECRET = get('CRON_SECRET');
const DIAG_TOKEN = get('DIAG_TOKEN');

// CI / preview で env が注入されていない場合は明示的に throw して fail させる (silent skip を避ける)。
test.beforeAll(() => {
  if (!INTERNAL_API_KEY || !CRON_SECRET || !DIAG_TOKEN) {
    throw new Error(
      'api-auth.spec requires INTERNAL_API_KEY / CRON_SECRET / DIAG_TOKEN to be set (env or .env.local)',
    );
  }
});

const NONEXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

interface RouteCase {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  tier: 'internal' | 'cron' | 'diag';
  body?: Record<string, unknown>;
}

// 全 12 ルート × 各 method
const ROUTES: RouteCase[] = [
  // tickets
  { method: 'PATCH', path: `/api/tickets/${NONEXISTENT_UUID}`, tier: 'internal', body: { status: 'untouched' } },
  { method: 'GET', path: `/api/tickets/${NONEXISTENT_UUID}/drafts`, tier: 'internal' },
  { method: 'POST', path: `/api/tickets/${NONEXISTENT_UUID}/drafts`, tier: 'internal', body: { body: 'x', source: 'manual' } },
  // draft-rag は本番では AI を呼ぶので、ここでは認証チェックのみ (404 期待)
  { method: 'POST', path: `/api/tickets/${NONEXISTENT_UUID}/draft-rag`, tier: 'internal' },
  // knowledge
  { method: 'GET', path: '/api/knowledge', tier: 'internal' },
  { method: 'GET', path: `/api/knowledge/${NONEXISTENT_UUID}`, tier: 'internal' },
  { method: 'PATCH', path: `/api/knowledge/${NONEXISTENT_UUID}`, tier: 'internal', body: { title: 'x' } },
  { method: 'DELETE', path: `/api/knowledge/${NONEXISTENT_UUID}`, tier: 'internal' },
  // improvement-suggestions / product-proposals
  { method: 'PATCH', path: `/api/improvement-suggestions/${NONEXISTENT_UUID}`, tier: 'internal', body: { status: 'accepted' } },
  { method: 'PATCH', path: `/api/product-proposals/${NONEXISTENT_UUID}`, tier: 'internal', body: { status: 'accepted' } },
  // products/suggest
  { method: 'GET', path: '/api/products/suggest?q=test', tier: 'internal' },
  // cron
  { method: 'GET', path: '/api/cron/sync-channels', tier: 'cron' },
  { method: 'POST', path: '/api/cron/sync-channels', tier: 'cron' },
  { method: 'GET', path: '/api/cron/rakuten-sync', tier: 'cron' },
  { method: 'POST', path: '/api/cron/rakuten-sync', tier: 'cron' },
  // diag
  { method: 'GET', path: '/api/diag/core', tier: 'diag' },
  { method: 'GET', path: '/api/diag/ai', tier: 'diag' },
];

async function call(
  request: APIRequestContext,
  c: RouteCase,
  headers: Record<string, string> = {},
  timeoutMs = 15000,
) {
  const init: Parameters<APIRequestContext['fetch']>[1] = {
    method: c.method,
    headers: { 'Content-Type': 'application/json', ...headers },
    failOnStatusCode: false,
    timeout: timeoutMs,
  };
  if (c.body) init.data = c.body;
  return request.fetch(c.path, init);
}

test.describe('/api/* 統一認証 — A: ヘッダなしは全 method 401', () => {
  for (const c of ROUTES) {
    test(`${c.method} ${c.path} (${c.tier}) → 401`, async ({ request }) => {
      const r = await call(request, c);
      expect(r.status(), `${c.method} ${c.path}`).toBe(401);
    });
  }
});

test.describe('/api/* 統一認証 — B: 間違った X-Internal-API-Key は 401', () => {
  const samples = ROUTES.filter((c) => c.tier === 'internal').slice(0, 2);
  for (const c of samples) {
    test(`${c.method} ${c.path} (wrong key) → 401`, async ({ request }) => {
      const r = await call(request, c, { 'X-Internal-API-Key': 'wrong-key-not-valid' });
      expect(r.status()).toBe(401);
    });
  }
});

test.describe('/api/* 統一認証 — C: 正しい X-Internal-API-Key は 非 401', () => {
  for (const c of ROUTES.filter((c) => c.tier === 'internal')) {
    // draft-rag は POST で AI を呼んでしまうのでスキップ (B/A で十分)
    if (c.path.endsWith('/draft-rag')) continue;
    test(`${c.method} ${c.path} (correct key) → 非 401`, async ({ request }) => {
      const r = await call(request, c, { 'X-Internal-API-Key': INTERNAL_API_KEY });
      expect(r.status(), `${c.method} ${c.path} body=${await r.text().catch(() => '')}`).not.toBe(401);
    });
  }
});

test.describe('/api/* 統一認証 — D: cron tier', () => {
  const cronRoutes = ROUTES.filter((c) => c.tier === 'cron');
  // 認証通過ケース (正規 token) は実 cron ジョブを起動する副作用があるため、
  // sync-channels の GET 1 ケースに限定して証明する。他は wrong-token の 401 で代替。
  const okSample = cronRoutes.find(
    (c) => c.path === '/api/cron/sync-channels' && c.method === 'GET',
  )!;

  test(`${okSample.method} ${okSample.path} Bearer CRON_SECRET → 非 401 (代表 1 ケース)`, async ({ request }) => {
    const r = await call(request, okSample, { Authorization: `Bearer ${CRON_SECRET}` });
    expect(r.status()).not.toBe(401);
  });
  test(`${okSample.method} ${okSample.path} X-Diag-Token → 非 401 (代表 1 ケース)`, async ({ request }) => {
    const r = await call(request, okSample, { 'X-Diag-Token': DIAG_TOKEN });
    expect(r.status()).not.toBe(401);
  });

  for (const c of cronRoutes) {
    test(`${c.method} ${c.path} Bearer wrong → 401`, async ({ request }) => {
      const r = await call(request, c, { Authorization: 'Bearer wrong-cron-secret' });
      expect(r.status()).toBe(401);
    });
  }
});

test.describe('/api/* 統一認証 — E: diag tier (Bearer 不許可)', () => {
  const diagRoutes = ROUTES.filter((c) => c.tier === 'diag');
  for (const c of diagRoutes) {
    // diag は実 AI / 実 Core API を叩くので timeout を 60s に拡張
    test(`${c.method} ${c.path} X-Diag-Token → 非 401`, async ({ request }) => {
      test.setTimeout(90_000);
      const r = await call(request, c, { 'X-Diag-Token': DIAG_TOKEN }, 60_000);
      expect(r.status()).not.toBe(401);
    });
    test(`${c.method} ${c.path} Bearer DIAG_TOKEN → 401 (diag は Bearer 不許可)`, async ({ request }) => {
      const r = await call(request, c, { Authorization: `Bearer ${DIAG_TOKEN}` });
      expect(r.status()).toBe(401);
    });
  }
});

test.describe('/api/* 統一認証 — F: 認証通過後 POST /api/knowledge を作成→削除 (cleanup 保証)', () => {
  test('POST /api/knowledge with key → 200 then DELETE cleanup', async ({ request }) => {
    const title = `__e2e_auth_smoke__${Date.now()}`;
    let createdId: string | null = null;
    try {
      const r = await request.fetch('/api/knowledge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-API-Key': INTERNAL_API_KEY,
        },
        data: { title, storage_scope: 'company', status: 'draft' },
        failOnStatusCode: false,
      });
      expect(r.status()).not.toBe(401);
      expect(r.ok()).toBeTruthy();
      const j = await r.json();
      expect(j.ok).toBe(true);
      createdId = j.article?.id ?? null;
      expect(createdId).toBeTruthy();
    } finally {
      if (createdId) {
        const del = await request.fetch(`/api/knowledge/${createdId}`, {
          method: 'DELETE',
          headers: { 'X-Internal-API-Key': INTERNAL_API_KEY },
          failOnStatusCode: false,
        });
        // cleanup 確実性: DELETE が 2xx で成功したことを assert する。
        // 失敗時はテストを fail させて、孤立した __e2e_auth_smoke__* 行が DB に残った
        // ことを明示する (運用上は手動 cleanup が必要)。
        expect(del.ok(), `cleanup DELETE for ${createdId} returned ${del.status()}`).toBeTruthy();
      }
    }
  });
});
