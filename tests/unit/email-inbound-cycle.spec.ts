/**
 * メール inbound webhook 1 サイクル統合テスト (in-process, origin-ai/Core を mock)
 *
 * フロー:
 *   1. ローカル HTTP mock (Core credential + origin-ai rag-* skill) を固定ポートで起動
 *   2. テスト用 channel_inboxes 行を投入 (email チャネルは migration で active)
 *   3. POST /api/channels/email/inbound のハンドラを直接呼ぶ
 *   4. ticket / inbound message / ticket_drafts(source='rag', status='pending') を assert
 *   5. 同一 Message-ID 再送 → duplicate、ドラフト二重生成なしを assert
 *   6. 未知宛先 → 404 を assert
 *   7. 実送信されないこと (status='pending'、outbound message 無し) を assert
 *
 * 注意: dev DB を共有するため、投入した行はテスト後に必ず削除する。
 */
import { test, expect } from '@playwright/test';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

const MOCK_PORT = 31907;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

// === source module の import 前に env を上書き (credentials/index.ts は module-init で評価) ===
process.env.CORE_API_URL = MOCK_URL;
process.env.INTERNAL_API_KEY = 'mock-internal-key';
process.env.ORIGIN_AI_URL = MOCK_URL;
process.env.CRON_SECRET = process.env.CRON_SECRET ?? 'mock-cron-secret';
process.env.DIAG_TOKEN = process.env.DIAG_TOKEN ?? 'mock-diag-token';

import { _clearCredentialCacheForTest } from '../../src/lib/credentials';
import { getSupabaseAdmin } from '../../src/lib/db/supabase-admin';
import { POST as inboundPost } from '../../app/api/channels/email/inbound/route';

const RUN = Date.now();
const TEST_ADDRESS = `e2e-inbound-${RUN}@cs-test.example`;
const MESSAGE_ID = `<e2e-${RUN}@cs-test>`;
const MOCK_DRAFT = 'お問い合わせありがとうございます。サイズ違いの件、交換にて承ります。';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

function startMock(): Promise<Server> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    // Core: supabase_service_role — 実 .env.local の値を返し getSupabaseAdmin() を成立させる
    if (url.startsWith('/api/credentials/supabase_service_role')) {
      const realKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').replace(/\s+$/, '');
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          service_code: 'supabase_service_role',
          scope_key: null,
          credentials: { service_key: realKey },
          metadata: {},
          valid_from: new Date().toISOString(),
          valid_to: null,
        }),
      );
      return;
    }
    // Core: origin_ai_internal credential
    if (url.startsWith('/api/credentials/origin_ai_internal')) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          service_code: 'origin_ai_internal',
          scope_key: null,
          credentials: { api_key: 'mock-rag-key' },
          metadata: {},
          valid_from: new Date().toISOString(),
          valid_to: null,
        }),
      );
      return;
    }
    // origin-ai rag skills
    if (url.startsWith('/api/skills/rag-pii-mask')) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = body.texts?.[0] ?? '';
      res.statusCode = 200;
      res.end(JSON.stringify({ results: [{ masked_text: text, replacements: [], mask_failed: false }] }));
      return;
    }
    if (url.startsWith('/api/skills/rag-hybrid-search')) {
      res.statusCode = 200;
      res.end(JSON.stringify({ results: [] }));
      return;
    }
    if (url.startsWith('/api/skills/rag-reply-draft')) {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          draft: MOCK_DRAFT,
          citations: [],
          no_answer: false,
          needs_human: false,
          confidence: 0.82,
          model: 'mock-model',
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found', url }));
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

function makeReq(payload: unknown): Request {
  return new Request(`${MOCK_URL}/api/channels/email/inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Diag-Token': process.env.DIAG_TOKEN as string,
    },
    body: JSON.stringify(payload),
  });
}

let mock: Server;
let channelId: string;
let inboxId: string;
let ticketId: string | null = null;

test.beforeAll(async () => {
  mock = await startMock();
  _clearCredentialCacheForTest();
  const sb = await getSupabaseAdmin();

  const { data: ch, error: chErr } = await sb
    .from('channels')
    .select('id, status')
    .eq('code', 'email')
    .maybeSingle();
  if (chErr || !ch) throw new Error(`email channel not found: ${chErr?.message}`);
  channelId = ch.id as string;
  expect(ch.status, 'email channel は active (migration 後)').toBe('active');

  const { data: inbox, error: inErr } = await sb
    .from('channel_inboxes')
    .insert({ channel_id: channelId, address: TEST_ADDRESS, status: 'active' })
    .select('id')
    .single();
  if (inErr) throw new Error(`seed inbox failed: ${inErr.message}`);
  inboxId = inbox.id as string;
});

test.afterAll(async () => {
  const sb = await getSupabaseAdmin();
  if (ticketId) await sb.from('tickets').delete().eq('id', ticketId); // cascade messages/drafts
  if (inboxId) await sb.from('channel_inboxes').delete().eq('id', inboxId);
  await new Promise<void>((r) => mock.close(() => r()));
});

test('受信→ticket化→origin-ai RAGドラフト→ticket_drafts(pending) 保存', async () => {
  const res = await inboundPost(makeReq({
    to: ` ${TEST_ADDRESS.toUpperCase()} `, // 大小文字/空白の表記揺れを正規化で吸収
    from: 'customer@buyer.example',
    from_name: '購入者 花子',
    subject: 'サイズ違いの商品が届きました',
    text: '注文と異なるサイズの商品が届きました。交換をお願いします。',
    message_id: MESSAGE_ID,
  }) as any);
  const json = await res.json();

  expect(res.status, 'A1: POST 200').toBe(200);
  expect(json.ok, 'A2: ok').toBe(true);
  expect(json.status, 'A3: ingested_with_draft').toBe('ingested_with_draft');
  expect(json.channelId, 'A4: email channel に解決').toBe(channelId);
  expect(json.ticketId, 'A5: ticketId 返却').toBeTruthy();
  ticketId = json.ticketId as string;

  const sb = await getSupabaseAdmin();

  // DB: ticket
  const { data: ticket } = await sb
    .from('tickets')
    .select('id, channel_id, external_id, customer_name, subject, status')
    .eq('id', ticketId)
    .single();
  expect(ticket?.channel_id, 'A6: ticket.channel_id').toBe(channelId);
  expect(ticket?.external_id, 'A7: external_id=Message-ID').toBe(MESSAGE_ID);
  expect(ticket?.status, 'A8: 新規 untouched').toBe('untouched');

  // DB: inbound message
  const { data: msgs } = await sb
    .from('messages')
    .select('direction, channel_message_id, body')
    .eq('ticket_id', ticketId);
  expect(msgs?.length, 'A9: message 1件').toBe(1);
  expect(msgs?.[0].direction, 'A10: inbound').toBe('inbound');
  expect(msgs?.[0].channel_message_id, 'A11: channel_message_id').toBe(`inquiry:${MESSAGE_ID}`);

  // DB: draft (source=rag, status=pending=実送信されない)
  const { data: drafts } = await sb
    .from('ticket_drafts')
    .select('body, source, status, sent_at, external_message_id')
    .eq('ticket_id', ticketId);
  expect(drafts?.length, 'A12: draft 1件').toBe(1);
  expect(drafts?.[0].body, 'A13: origin-ai のドラフト本文').toBe(MOCK_DRAFT);
  expect(drafts?.[0].source, 'A14: source=rag').toBe('rag');
  expect(drafts?.[0].status, 'A15: status=pending (auto-approve しない)').toBe('pending');
  expect(drafts?.[0].sent_at, 'A16: 未送信').toBeNull();
});

test('同一 Message-ID 再送は duplicate、ドラフト二重生成なし', async () => {
  const res = await inboundPost(makeReq({
    to: TEST_ADDRESS,
    from: 'customer@buyer.example',
    text: '注文と異なるサイズの商品が届きました。交換をお願いします。',
    message_id: MESSAGE_ID,
  }) as any);
  const json = await res.json();
  expect(res.status, 'B1: 200').toBe(200);
  expect(json.status, 'B2: duplicate').toBe('duplicate');

  const sb = await getSupabaseAdmin();
  const { data: drafts } = await sb
    .from('ticket_drafts')
    .select('id')
    .eq('ticket_id', ticketId);
  expect(drafts?.length, 'B3: draft は 1件のまま').toBe(1);
});

test('未知宛先は 404 unknown recipient', async () => {
  const res = await inboundPost(makeReq({
    to: `nobody-${RUN}@unknown.example`,
    text: 'hello',
    message_id: `<unknown-${RUN}@x>`,
  }) as any);
  const json = await res.json();
  expect(res.status, 'C1: 404').toBe(404);
  expect(json.ok, 'C2: ok=false').toBe(false);
});

test('認可なしは 401', async () => {
  const noAuth = new Request(`${MOCK_URL}/api/channels/email/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: TEST_ADDRESS, text: 'x', message_id: 'y' }),
  });
  const res = await inboundPost(noAuth as any);
  expect(res.status, 'D1: 401').toBe(401);
});
