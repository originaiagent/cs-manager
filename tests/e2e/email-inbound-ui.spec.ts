/**
 * 段階3: メール受信ドラフトの UI 再描画 E2E (chromium)
 *
 * 目的: メール由来の ticket と、その origin-ai RAG ドラフト (source='rag', status='pending') が
 *       既存の受信箱 / チケット詳細 UI に正しく再描画されることを検証する。
 *
 * Webhook → DB の経路は tests/unit/email-inbound-cycle.spec.ts が origin-ai を mock して
 * 決定論的に検証済み。本 spec は「DB に保存されたメールドラフトが UI に出るか」を担保する。
 * 実送信されないこと (status='pending' のまま) も DB で確認する。
 *
 * チャネル/メアドはハードコードせず、email チャネル (migration で active) に test inbox を
 * 動的登録する。投入行はテスト後に必ず削除する。
 */
import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const RUN = Date.now();
const TEST_ADDRESS = `e2e-ui-${RUN}@cs-test.example`;
const EXTERNAL_ID = `<e2e-ui-${RUN}@cs-test>`;
const SUBJECT = `E2Eメール件名 ${RUN}`;
const DRAFT_BODY = `お問い合わせありがとうございます。E2E確認用ドラフト ${RUN}。`;

let sb: SupabaseClient;
let channelId: string;
let inboxId: string;
let ticketId: string;

test.beforeAll(async () => {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\s+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').replace(/\s+$/, '');
  if (!url || !key) throw new Error('Supabase env 未設定 (.env.local 確認)');
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: ch } = await sb
    .from('channels')
    .select('id, status, display_name')
    .eq('code', 'email')
    .maybeSingle();
  if (!ch) throw new Error('email channel が存在しません (migration 未適用?)');
  expect(ch.status, 'email channel は active').toBe('active');
  channelId = ch.id as string;

  const { data: inbox, error: inErr } = await sb
    .from('channel_inboxes')
    .insert({ channel_id: channelId, address: TEST_ADDRESS, status: 'active' })
    .select('id')
    .single();
  if (inErr) throw new Error(`inbox seed 失敗: ${inErr.message}`);
  inboxId = inbox.id as string;

  // メール ingest 完了状態 (ticket + inbound message + RAG draft) を直接投入
  const { data: ticket, error: tErr } = await sb
    .from('tickets')
    .insert({
      channel_id: channelId,
      external_id: EXTERNAL_ID,
      customer_name: '購入者 花子',
      customer_email: 'buyer@example.jp',
      subject: SUBJECT,
      status: 'untouched',
      channel_meta: { source: 'email', to: TEST_ADDRESS, message_id: EXTERNAL_ID },
    })
    .select('id')
    .single();
  if (tErr) throw new Error(`ticket seed 失敗: ${tErr.message}`);
  ticketId = ticket.id as string;

  await sb.from('messages').insert({
    ticket_id: ticketId,
    channel_message_id: `inquiry:${EXTERNAL_ID}`,
    direction: 'inbound',
    body: '注文と異なるサイズが届きました。交換をお願いします。',
    sender_name: '購入者 花子',
    sent_at: new Date().toISOString(),
  });

  await sb.from('ticket_drafts').insert({
    ticket_id: ticketId,
    body: DRAFT_BODY,
    source: 'rag',
    // 分離済み顧客向け本文として seed (page の送信安全ゲートで textarea に表示される)。
    // 未指定だと is_separated=false=legacy 扱いとなり textarea が空になる。
    is_separated: true,
    // status は既定 'pending' (実送信されない)
  });
});

test.afterAll(async () => {
  if (ticketId) await sb.from('tickets').delete().eq('id', ticketId); // cascade messages/drafts
  if (inboxId) await sb.from('channel_inboxes').delete().eq('id', inboxId);
});

test('受信箱にメール由来 ticket が表示される', async ({ page }) => {
  await page.goto('/inbox', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '受信箱' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(SUBJECT)).toBeVisible({ timeout: 15000 });
});

test('チケット詳細にメールドラフト(RAG返信案)が再描画される', async ({ page }) => {
  await page.goto(`/tickets/${ticketId}`, { waitUntil: 'domcontentloaded' });
  // 返信フォームの textarea に保存済みドラフト本文が入っている
  const textarea = page.locator('textarea');
  await expect(textarea).toHaveValue(DRAFT_BODY, { timeout: 15000 });
  // 下書きソースが RAG 返信案として表示される
  await expect(page.getByText('RAG返信案')).toBeVisible();
});

test('実送信されていない (draft は pending のまま、outbound message 無し)', async () => {
  const { data: drafts } = await sb
    .from('ticket_drafts')
    .select('status, sent_at, source')
    .eq('ticket_id', ticketId);
  expect(drafts?.length).toBe(1);
  expect(drafts?.[0].status, 'status=pending').toBe('pending');
  expect(drafts?.[0].sent_at, '未送信').toBeNull();

  const { data: outbound } = await sb
    .from('messages')
    .select('id')
    .eq('ticket_id', ticketId)
    .eq('direction', 'outbound');
  expect(outbound?.length, 'outbound message 無し').toBe(0);
});
