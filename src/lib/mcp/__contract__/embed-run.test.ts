/**
 * 入口エンドポイント /api/embed-run の fail-closed ゲートテスト (vitest)。
 *
 * cs-manager は窓口済ツール。新規 handshake は作らず、実需 work
 * `oneshot:inquiry-to-customer-record` 用の入口配線のみを検証する。
 *
 * 契約 §3 / §7 認可攻撃マトリクスのうち入口層に該当する項目:
 *   - 内部認証 (X-Internal-API-Key) なしは 401 (ブラウザ直叩き不可)
 *   - target_type ≠ customer_record は 403 (form 流用拒否)
 *   - 存在しない target_id (ticket) は 404 (有料 run 起動拒否)
 *   - 鍵未配布 (EMBED_CLIENT_KEY 未設定) は 503
 *   - 認証 + 正 target_type + 存在 ticket → run 起動が completed まで進む
 *
 * supabase / origin-ai はモック。ネットワークは fetch stub。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- env (route が参照) ------------------------------------------------------
const INTERNAL_KEY = 'test-internal-key';
process.env.EMBED_CLIENT_KEY = 'test-embed-key';
process.env.ORIGIN_AI_BASE_URL = 'https://origin-ai.example.com';
process.env.EMBED_RUN_POLL_INTERVAL_MS = '5';

// 接続鍵 Core 集約 Done-1: 内部認証 (authorizeInternalApiRoute) は Core core_internal_shared
// 取得値で照合する。Core 解決を mock し、期待鍵を INTERNAL_KEY に固定する。
vi.mock('@/lib/credentials', () => ({
  getInboundVerifyKeys: async () => [INTERNAL_KEY],
}));

// --- supabase-admin モック ---------------------------------------------------
// ticketStore に id があれば存在扱い。
const ticketStore: Record<string, boolean> = { 'ticket-uuid': true };

vi.mock('@/lib/db/supabase-admin', () => {
  return {
    getSupabaseAdmin: vi.fn(async () => ({
      from: (_table: string) => ({
        select: (_cols: string) => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () =>
              ticketStore[val] ? { data: { id: val }, error: null } : { data: null, error: null },
          }),
        }),
      }),
    })),
  };
});

// 動的 import (mock 適用後)
const { POST } = await import('../../../../app/api/embed-run/route');

// 有効な UUID (route の UUID_RE を通す)
const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const MISSING_UUID = '99999999-2222-4333-8444-555555555555';

// --- fetch stub (origin-ai /api/embed/run + /runs/:id) -----------------------
let restoreFetch: (() => void) | null = null;
function installEmbedRunStub(opts?: { runStatus?: number; finalStatus?: string }) {
  const orig = global.fetch;
  global.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith('/api/embed/run')) {
      const status = opts?.runStatus ?? 202;
      return { ok: status < 400, status, json: async () => ({ run_id: 'run-xyz' }) } as any;
    }
    if (u.includes('/api/embed/runs/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: opts?.finalStatus ?? 'completed', result: { drafted: true } }),
      } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;
  restoreFetch = () => {
    global.fetch = orig;
  };
}

beforeEach(() => {
  ticketStore['ticket-uuid'] = true;
  ticketStore[VALID_UUID] = true;
  delete ticketStore[MISSING_UUID];
  installEmbedRunStub();
});
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});

// NextRequest 互換の最小モック (route は headers.get / json() のみ使用)
function makeReq(body: unknown, headers: Record<string, string>) {
  const h = new Headers(headers);
  return {
    method: 'POST',
    headers: h,
    json: async () => body,
  } as any;
}

describe('入口 /api/embed-run fail-closed', () => {
  it('(認可攻撃) 内部認証なしは 401 (ブラウザ直叩き不可)', async () => {
    const req = makeReq({ target_type: 'customer_record', target_id: VALID_UUID }, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('(認可攻撃#1/9) target_type が customer_record 以外は 403', async () => {
    const req = makeReq(
      { target_type: 'memo', target_id: VALID_UUID },
      { 'x-internal-api-key': INTERNAL_KEY },
    );
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('(IDOR緩和) 存在しない ticket は 404', async () => {
    const req = makeReq(
      { target_type: 'customer_record', target_id: MISSING_UUID },
      { 'x-internal-api-key': INTERNAL_KEY },
    );
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('不正 UUID の target_id は 400', async () => {
    const req = makeReq(
      { target_type: 'customer_record', target_id: 'not-a-uuid' },
      { 'x-internal-api-key': INTERNAL_KEY },
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('鍵未配布 (EMBED_CLIENT_KEY 未設定) は 503', async () => {
    const saved = process.env.EMBED_CLIENT_KEY;
    delete process.env.EMBED_CLIENT_KEY;
    try {
      const req = makeReq(
        { target_type: 'customer_record', target_id: VALID_UUID },
        { 'x-internal-api-key': INTERNAL_KEY },
      );
      const res = await POST(req);
      expect(res.status).toBe(503);
    } finally {
      process.env.EMBED_CLIENT_KEY = saved;
    }
  });

  it('認証 + 正 target_type + 存在 ticket → run 起動が completed まで進む', async () => {
    const req = makeReq(
      { target_type: 'customer_record', target_id: VALID_UUID },
      { 'x-internal-api-key': INTERNAL_KEY },
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe('completed');
    expect(json.run_id).toBe('run-xyz');
  });

  it('origin run 起動失敗 (非202) は 502', async () => {
    if (restoreFetch) restoreFetch();
    installEmbedRunStub({ runStatus: 500 });
    const req = makeReq(
      { target_type: 'customer_record', target_id: VALID_UUID },
      { 'x-internal-api-key': INTERNAL_KEY },
    );
    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it('run が failed terminal なら 502', async () => {
    if (restoreFetch) restoreFetch();
    installEmbedRunStub({ finalStatus: 'failed' });
    const req = makeReq(
      { target_type: 'customer_record', target_id: VALID_UUID },
      { 'x-internal-api-key': INTERNAL_KEY },
    );
    const res = await POST(req);
    expect(res.status).toBe(502);
  });
});
