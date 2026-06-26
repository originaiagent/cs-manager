/**
 * Yahoo!ショッピング 問い合わせ受信アダプタ 単体テスト (DB/ネットワーク非依存)
 *
 * 公式仕様 (質問一覧/詳細API) に整合したフェイク応答で fetchInbox を検証:
 *  - 一覧 externalTalkList: start/result ページング、summary.topic.count、headlines[]
 *  - 詳細 externalTalkDetail: topic + messages[] (postUserType/postdate)
 * 1req/s throttle は vi.useFakeTimers で潰す。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { yahooAdapter } from '@/channels/yahoo/adapter';
import type { ChannelAdapterContext, AdapterLogger } from '@/channels/_lib/adapter';
import type { NormalizedTicketWithMessages } from '@/channels/_lib/types';

function makeLogger(): AdapterLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const TOTAL = 40;
// since(2026-06-01) より後の UNIX 秒 (kept されるよう新しめに)
const RECENT_UNIX = 1781000000; // ~2026-06-09

function makeHeadlines(start: number) {
  // start は 1 始まり。n = start..start+19 のうち TOTAL までを返す。
  const out = [];
  for (let i = 0; i < 20; i++) {
    const n = start + i;
    if (n > TOTAL) break;
    out.push({
      topicId: `T${n}`,
      isCompleted: n % 2 === 0,
      userPostTime: RECENT_UNIX,
      sellerPostTime: RECENT_UNIX,
      title: `件名 ${n}`,
      userMaskedId: `masked-${n}`,
      itemCode: 'item-1',
      orderId: 'order-1',
    });
  }
  return out;
}

function makeDetail(topicId: string) {
  return {
    topic: {
      isComplete: false,
      title: `詳細件名 ${topicId}`,
      itemcode: 'item-1',
      orderid: 'order-1',
      categoryName: '配送',
      userMaskedIdx: `masked-${topicId}`,
    },
    messages: [
      {
        messageId: `${topicId}-m1`,
        postUserType: 'buyer',
        postdate: RECENT_UNIX,
        body: '注文した商品はいつ届きますか',
        fileList: [{ fileName: 'a.png', objectKey: 'k1', thumbnailUrl: 'https://x/y.png', fileExt: 'png', fileSize: 100 }],
      },
      {
        messageId: `${topicId}-m2`,
        postUserType: 'seller',
        postdate: RECENT_UNIX + 1800,
        body: '本日発送予定です',
      },
    ],
  };
}

function makeFakeFetch() {
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input);
    const url = new URL(input);
    const json = (obj: unknown) =>
      new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });

    if (url.pathname.endsWith('/externalTalkList')) {
      const start = Number(url.searchParams.get('start') ?? '1');
      return json({ summary: { topic: { start, end: start + 19, count: TOTAL } }, headlines: makeHeadlines(start) });
    }
    if (url.pathname.endsWith('/externalTalkDetail')) {
      const topicId = url.searchParams.get('topicId') ?? 'unknown';
      return json(makeDetail(topicId));
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

function makeCtx(fetchImpl: unknown, extraConfig: Record<string, unknown> = {}, since: Date | null = new Date('2026-06-01T00:00:00Z')): ChannelAdapterContext {
  return {
    channel: { id: 'chan-yahoo-1', code: 'yahoo', config: { __fetchImpl: fetchImpl, store_id: 'seller-xyz', ...extraConfig } },
    since,
    logger: makeLogger(),
    credentials: { access_token: 'fake-token-123' },
  };
}

async function drainWithFakeTimers(
  gen: AsyncGenerator<NormalizedTicketWithMessages, void, void>,
): Promise<NormalizedTicketWithMessages[]> {
  const out: NormalizedTicketWithMessages[] = [];
  let next = gen.next();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await Promise.resolve();
    await vi.runAllTimersAsync();
    const res = await next;
    if (res.done) break;
    out.push(res.value);
    next = gen.next();
  }
  return out;
}

describe('yahooAdapter.fetchInbox', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start/result で 40 件を 2 ページ走査して yield (sellerId/start/result を送る, dateType は既定で送らない)', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(makeCtx(fetchImpl)));

    expect(results).toHaveLength(40);
    const listCalls = calls.filter((c) => c.includes('/externalTalkList'));
    expect(listCalls).toHaveLength(2); // start=1, start=21 (start+20>40 で終端)
    expect(calls.filter((c) => c.includes('/externalTalkDetail'))).toHaveLength(40);
    // 公式パラメータ名で送っている
    expect(listCalls[0]).toContain('sellerId=seller-xyz');
    expect(listCalls[0]).toContain('start=1');
    expect(listCalls[0]).toContain('result=20');
    expect(listCalls[1]).toContain('start=21');
    // 未検証 dateType enum は既定で送らない (誤 enum 400 回避)
    expect(listCalls[0]).not.toContain('dateType');
    // detail は sellerId + topicId
    const detail0 = calls.find((c) => c.includes('/externalTalkDetail'))!;
    expect(detail0).toContain('sellerId=seller-xyz');
    expect(detail0).toContain('topicId=T1');
  });

  it('direction/status 丸めと channelMessageId / channelMeta を map する', async () => {
    const { fetchImpl } = makeFakeFetch();
    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(makeCtx(fetchImpl)));
    const first = results[0];

    expect(first.ticket.externalId).toBe('T1');
    expect(first.ticket.customerName).toBeUndefined(); // 氏名は API 非返却
    // subject は adapter では設定しない (design §2: ingest 層の generateSubject() が唯一の書き込み口)
    expect(first.ticket.subject).toBeUndefined();
    expect(first.ticket.status).toBe('untouched'); // isComplete=false
    expect(first.ticket.channelMeta).toMatchObject({ itemCode: 'item-1', orderId: 'order-1', categoryName: '配送' });

    const [m1, m2] = first.messages;
    expect(m1.direction).toBe('inbound'); // buyer
    expect(m1.senderType).toBe('customer');
    expect(m1.channelMessageId).toBe('talk:T1-m1');
    expect(m1.body).toBe('注文した商品はいつ届きますか');
    expect(m1.sentAt).toMatch(/^2026-/); // UNIX秒 → ISO
    expect(m1.attachments?.[0]).toMatchObject({ label: 'a.png', path: 'k1', url: 'https://x/y.png' });
    expect(m2.direction).toBe('outbound'); // seller
    expect(m2.senderType).toBe('staff');
    expect(m2.channelMessageId).toBe('talk:T1-m2');
  });

  it('完了トピック (isCompleted) は status=done に丸める', async () => {
    const { fetchImpl } = makeFakeFetch();
    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(makeCtx(fetchImpl)));
    // T2 は isCompleted=true (n%2==0)。detail.topic.isComplete=false でも headline 完了で done。
    const t2 = results.find((r) => r.ticket.externalId === 'T2')!;
    expect(t2.ticket.status).toBe('done');
  });

  it('credentials が無ければ throw する', async () => {
    const { fetchImpl } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.credentials = {};
    await expect(yahooAdapter.fetchInbox(ctx).next()).rejects.toThrow(/access token/i);
  });

  it('sellerId が config/credential いずれにも無ければ throw する', async () => {
    const { fetchImpl } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl, { store_id: '' }); // credentials は access_token のみ
    await expect(yahooAdapter.fetchInbox(ctx).next()).rejects.toThrow(/sellerId|store_id/i);
  });

  it('sellerId を Core credential (seller_id) から解決できる (config store_id 不要=キー投入だけで稼働)', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl, { store_id: '' });
    ctx.credentials = { access_token: 'tok', seller_id: 'cred-seller-9' };
    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(ctx));
    expect(results.length).toBeGreaterThan(0);
    expect(calls.find((c) => c.includes('/externalTalkList'))!).toContain('sellerId=cred-seller-9');
  });

  it('token フォールバック (credentials.token) を許容する', async () => {
    const { fetchImpl } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.credentials = { token: 'fallback-token' };
    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(ctx));
    expect(results.length).toBeGreaterThan(0);
  });

  it('since より古い topic は skip する (client 側 since フィルタ)', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      calls.push(input);
      const url = new URL(input);
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/externalTalkList')) {
        return json({
          summary: { topic: { start: 1, end: 2, count: 2 } },
          headlines: [
            { topicId: 'NEW', isCompleted: false, userPostTime: RECENT_UNIX, title: 'new' },
            { topicId: 'OLD', isCompleted: false, userPostTime: 1700000000, title: 'old' }, // 2023 → since より前
          ],
        });
      }
      return json(makeDetail(url.searchParams.get('topicId') ?? 'x'));
    };
    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(makeCtx(fetchImpl)));
    const ids = results.map((r) => r.ticket.externalId);
    expect(ids).toContain('NEW');
    expect(ids).not.toContain('OLD');
    // OLD は detail を取りにいかない
    expect(calls.some((c) => c.includes('topicId=OLD'))).toBe(false);
  });

  it('detail 取得失敗時は headline.body を inbound フォールバックして取りこぼさない', async () => {
    const fetchImpl = async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname.endsWith('/externalTalkList')) {
        const start = Number(url.searchParams.get('start') ?? '1');
        const headlines = start === 1
          ? [{ topicId: 'T1', isCompleted: false, userPostTime: RECENT_UNIX, title: 'a', body: '届いていません' }]
          : [];
        return new Response(JSON.stringify({ summary: { topic: { start, end: start, count: 1 } }, headlines }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('boom', { status: 500 });
    };
    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(makeCtx(fetchImpl)));
    expect(results).toHaveLength(1);
    expect(results[0].ticket.externalId).toBe('T1');
    // detail 失敗でも headline.body から inbound メッセージを 1 件確保 (取りこぼし防止)
    expect(results[0].messages).toHaveLength(1);
    expect(results[0].messages[0].direction).toBe('inbound');
    expect(results[0].messages[0].body).toBe('届いていません');
    expect(results[0].messages[0].channelMessageId).toBe('talk:T1:headline');
  });
});
