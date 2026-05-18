/**
 * 楽天 R-MessE 1 サイクル mock E2E
 *
 * 設計レビュー: Gemini APPROVE (2026-05-07)
 *
 * フロー:
 *   1. Core mock (`/api/credentials/rakuten_rmesse?scope_key=...`) と楽天 mock (`/inquirymng-api/...`)
 *      をローカル HTTP server (固定ポート) として起動
 *   2. テスト用 channel + ticket + approved draft を Supabase に投入
 *   3. cron route handler `GET /api/cron/rakuten-sync` を呼び出し
 *   4. 受信 (fetchInbox) → 送信 (sendApprovedDrafts) → DB 状態を assert
 *
 * 注意: dev DB を共有するため、既存 rakuten channel は一時的に inactive 化、
 *       テスト終了後に元に戻す。
 *
 * 設計上の制約: source module は env を module-init 時に評価するため、
 *   - 固定ポートを使い、import 前に process.env.CORE_API_URL を設定する
 *   - import 順序が保たれる Playwright loader (esbuild CJS) 前提
 */
import { test, expect } from '@playwright/test';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

const CORE_MOCK_PORT = 31888;
const RAKUTEN_MOCK_PORT = 31889;
const CORE_MOCK_URL = `http://127.0.0.1:${CORE_MOCK_PORT}`;
const RAKUTEN_MOCK_URL = `http://127.0.0.1:${RAKUTEN_MOCK_PORT}`;

// === 重要: source module の import 前に env を上書きする ===
process.env.CORE_API_URL = CORE_MOCK_URL;
process.env.INTERNAL_API_KEY = 'mock-internal-key';
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'mock-cron-secret';

// 以下の static import は env 上書き後にロードされる必要がある (esbuild CJS は import 順序を保つ)
import { _clearCredentialCacheForTest } from '../../src/lib/credentials';
import { getSupabaseAdmin } from '../../src/lib/db/supabase-admin';
import { GET as cronGet } from '../../app/api/cron/rakuten-sync/route';

const TEST_SHOP_ID = 'mock_shop_e2e_001';
const TEST_INQUIRY_NUMBER = 'mock-inq-e2e-001';
const REPLY_REGDATE = '2026-05-07T13:30:00';
const RAKUTEN_REPLY_ID = 9999;

const credentialRequests: Array<{ path: string; headers: Record<string, string> }> = [];
const rakutenRequests: Array<{ method: string; path: string; body: string }> = [];

let coreServer: Server;
let rakutenServer: Server;
let supabase: Awaited<ReturnType<typeof getSupabaseAdmin>>;
let testChannelId: string;
let testTicketId: string;
let testDraftId: string;
// 既存 rakuten 行を一時的に書き換えるパターンを採用 (channels.code に UNIQUE 制約があるため)
let preservedChannel: { id: string; config: any; status: string } | null = null;
let createdNewChannel = false;

function listenOn(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer(handler);
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  let buf = '';
  for await (const chunk of req) buf += chunk;
  return buf;
}

test.beforeAll(async () => {
  // === 1. Core mock サーバ起動 ===
  //   - supabase_service_role: cs-manager が getSupabaseAdmin() 初回呼び出し時に解決
  //   - rakuten_rmesse: outbound / adapter 内で getCredential(shopId) で解決
  coreServer = await listenOn(CORE_MOCK_PORT, (req, res) => {
    const path = req.url ?? '';
    credentialRequests.push({
      path,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k.toLowerCase(),
          Array.isArray(v) ? v.join(',') : v ?? '',
        ]),
      ),
    });
    res.setHeader('Content-Type', 'application/json');
    if (path.startsWith('/api/credentials/supabase_service_role')) {
      // テストでは getSupabaseAdmin() の Core 解決を擬似的に通すために
      // 実 SUPABASE_SERVICE_ROLE_KEY (.env.local の値) を返す。
      // ※ 単体テストは本物の Supabase に接続する e2e 寄り設計のため。
      const realKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').replace(/\s+$/, '');
      res.end(
        JSON.stringify({
          service_code: 'supabase_service_role',
          scope_key: 'jpnsoqzzylahpandbfcz',
          credentials: { service_key: realKey },
          metadata: {},
          valid_from: '2026-05-18T00:00:00Z',
          valid_to: null,
        }),
      );
      return;
    }
    // それ以外 (rakuten_rmesse 想定) はデフォルトで楽天 credential を返す
    res.end(
      JSON.stringify({
        service_code: 'rakuten_rmesse',
        scope_key: TEST_SHOP_ID,
        credentials: {
          rms_user: 'mock_user',
          service_secret: 'mock_service_secret',
          license_key: 'mock_license_key',
          dev_auth_key: 'mock_dev_auth',
        },
        metadata: {},
        valid_from: '2026-04-01T00:00:00Z',
        valid_to: null,
      }),
    );
  });

  // === 2. 楽天 R-MessE mock サーバ起動 ===
  rakutenServer = await listenOn(RAKUTEN_MOCK_PORT, async (req, res) => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '';
    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : '';
    rakutenRequests.push({ method, path, body });
    res.setHeader('Content-Type', 'application/json');

    if (path.startsWith('/inquirymng-api/inquiries')) {
      res.end(
        JSON.stringify({
          totalCount: 1,
          totalPageCount: 1,
          page: 1,
          list: [
            {
              inquiryNumber: TEST_INQUIRY_NUMBER,
              message: 'mock inquiry body',
              regDate: '2026-05-07T13:00:00',
              userName: 'テスト 太郎',
              shopId: 12345,
            },
          ],
        }),
      );
      return;
    }
    if (path.startsWith(`/inquirymng-api/inquiry/${TEST_INQUIRY_NUMBER}`)) {
      const replyAlreadySent =
        rakutenRequests.filter(
          (r) => r.method === 'POST' && r.path === '/inquirymng-api/inquiry/reply',
        ).length > 0;
      res.end(
        JSON.stringify({
          result: {
            inquiryNumber: TEST_INQUIRY_NUMBER,
            message: 'mock inquiry body',
            regDate: '2026-05-07T13:00:00',
            userName: 'テスト 太郎',
            shopId: 12345,
            replies: replyAlreadySent
              ? [
                  {
                    id: RAKUTEN_REPLY_ID,
                    message: 'mock approved reply',
                    regDate: REPLY_REGDATE,
                  },
                ]
              : [],
          },
        }),
      );
      return;
    }
    if (path === '/inquirymng-api/inquiry/reply' && method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      res.end(
        JSON.stringify({
          result: {
            inquiryNumber: parsed.inquiryNumber,
            message: parsed.message,
            regDate: REPLY_REGDATE,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  _clearCredentialCacheForTest();
  supabase = await getSupabaseAdmin();

  // === 3. channels.code='rakuten' は UNIQUE のため既存行を一時的に書き換えて再利用 ===
  const { data: existing } = await supabase
    .from('channels')
    .select('id, config, status')
    .eq('code', 'rakuten')
    .maybeSingle();

  const testConfig = {
    api_base: `${RAKUTEN_MOCK_URL}/inquirymng-api`,
    page_limit: 100,
    request_delay_ms: 1,
    lookback_minutes: 1440,
    shop_id: TEST_SHOP_ID,
  };

  if (existing) {
    preservedChannel = {
      id: (existing as any).id,
      config: (existing as any).config ?? {},
      status: (existing as any).status,
    };
    const { error: updErr } = await supabase
      .from('channels')
      .update({ config: testConfig, status: 'active' })
      .eq('id', preservedChannel.id);
    if (updErr) throw new Error(`channel update failed: ${updErr.message}`);
    testChannelId = preservedChannel.id;
  } else {
    const { data: ch, error: chErr } = await supabase
      .from('channels')
      .insert({
        code: 'rakuten',
        display_name: 'rakuten (e2e mock)',
        status: 'active',
        config: testConfig,
      })
      .select('id')
      .single();
    if (chErr) throw new Error(`test channel insert failed: ${chErr.message}`);
    testChannelId = ch.id;
    createdNewChannel = true;
  }

  // === 5. Pre-seed: ticket + approved draft ===
  const { data: ticket, error: tErr } = await supabase
    .from('tickets')
    .insert({
      channel_id: testChannelId,
      external_id: TEST_INQUIRY_NUMBER,
      customer_name: 'テスト 太郎',
      status: 'untouched',
      channel_meta: { shopId: 12345 },
    })
    .select('id')
    .single();
  if (tErr) throw new Error(`test ticket insert failed: ${tErr.message}`);
  testTicketId = ticket.id;

  const { data: draft, error: dErr } = await supabase
    .from('ticket_drafts')
    .insert({
      ticket_id: testTicketId,
      body: 'mock approved reply',
      source: 'ai_draft',
      status: 'approved',
    })
    .select('id, status')
    .single();
  if (dErr) throw new Error(`test draft insert failed: ${dErr.message}`);
  testDraftId = draft.id;
});

test.afterAll(async () => {
  if (supabase && testChannelId) {
    if (testTicketId) {
      await supabase.from('ticket_drafts').delete().eq('ticket_id', testTicketId);
      await supabase.from('messages').delete().eq('ticket_id', testTicketId);
      await supabase.from('tickets').delete().eq('id', testTicketId);
    }
    await supabase.from('channel_sync_state').delete().eq('channel_id', testChannelId);
    if (createdNewChannel) {
      await supabase.from('channels').delete().eq('id', testChannelId);
    } else if (preservedChannel) {
      // 既存行を上書きしていたので元の config / status に戻す
      await supabase
        .from('channels')
        .update({ config: preservedChannel.config, status: preservedChannel.status })
        .eq('id', preservedChannel.id);
    }
  }
  if (coreServer) await new Promise((r) => coreServer.close(() => r(null)));
  if (rakutenServer) await new Promise((r) => rakutenServer.close(() => r(null)));
});

test('rakuten 1 サイクル: 受信 → 送信 → DB 状態反映', async () => {
  const req = new Request(`http://localhost/api/cron/rakuten-sync`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const res = await cronGet(req as any);
  const json = (await res.json()) as any;

  expect(res.status, 'A1: cron HTTP status 200').toBe(200);
  expect(json.ok, 'A2: cron ok=true').toBe(true);
  expect(Array.isArray(json.channels), 'A3: channels 配列').toBe(true);
  expect(json.channels.length, 'A4: 1 channel 処理').toBe(1);

  const ch = json.channels[0];
  expect(ch.channelCode, 'A5: channelCode=rakuten').toBe('rakuten');
  expect(ch.inbound.ticketsProcessed, 'A6: 受信 ticket >=1').toBeGreaterThanOrEqual(1);
  expect(ch.outbound.attempted, 'A7: 送信試行 1 件').toBe(1);
  expect(ch.outbound.succeeded, 'A8: 送信成功 1 件').toBe(1);
  expect(ch.outbound.failed, 'A9: 送信失敗 0 件').toBe(0);

  // getSupabaseAdmin() で supabase_service_role が解決されているはずなので
  // rakuten_rmesse の解決は credentialRequests から path で探索する。
  const rakutenCredReq = credentialRequests.find((r) =>
    r.path.startsWith('/api/credentials/rakuten_rmesse'),
  );
  expect(rakutenCredReq, 'A10: Core credential 呼び出し (rakuten_rmesse) 存在').toBeTruthy();
  expect(rakutenCredReq!.headers['x-internal-api-key'], 'A11: X-Internal-API-Key').toBe(
    'mock-internal-key',
  );
  expect(rakutenCredReq!.path, 'A12: scope_key 一致').toContain(`scope_key=${TEST_SHOP_ID}`);

  const replyCalls = rakutenRequests.filter(
    (r) => r.method === 'POST' && r.path === '/inquirymng-api/inquiry/reply',
  );
  expect(replyCalls.length, 'A13: POST /inquiry/reply 1 回').toBe(1);
  const sentBody = JSON.parse(replyCalls[0].body);
  expect(sentBody.inquiryNumber, 'A14: inquiryNumber 一致').toBe(TEST_INQUIRY_NUMBER);
  expect(sentBody.shopId, 'A15: shopId 一致').toBe(TEST_SHOP_ID);
  expect(sentBody.message, 'A16: message body 一致').toBe('mock approved reply');

  const { data: draftAfter, error: daErr } = await supabase
    .from('ticket_drafts')
    .select('status, sent_at, external_message_id, last_error')
    .eq('id', testDraftId)
    .single();
  expect(daErr).toBeNull();
  expect((draftAfter as any).status, 'A17: draft.status=sent').toBe('sent');
  expect((draftAfter as any).sent_at, 'A18: sent_at 非 null').not.toBeNull();
  expect((draftAfter as any).external_message_id, 'A19: external_message_id=9999').toBe(
    String(RAKUTEN_REPLY_ID),
  );
  expect((draftAfter as any).last_error, 'A20: last_error null').toBeNull();

  const { data: messages } = await supabase
    .from('messages')
    .select('direction, body, channel_message_id')
    .eq('ticket_id', testTicketId)
    .order('sent_at', { ascending: true });
  expect((messages ?? []).length, 'A21: messages >= 1').toBeGreaterThanOrEqual(1);
  const inboundMsg = (messages as any[]).find((m) => m.direction === 'inbound');
  expect(inboundMsg, 'A22: inbound message 存在').toBeTruthy();
  expect(inboundMsg.body, 'A23: inbound body 一致').toBe('mock inquiry body');

  const { data: syncState } = await supabase
    .from('channel_sync_state')
    .select('last_synced_at, last_external_id')
    .eq('channel_id', testChannelId)
    .single();
  expect((syncState as any).last_synced_at, 'A24: last_synced_at 非 null').not.toBeNull();
});
