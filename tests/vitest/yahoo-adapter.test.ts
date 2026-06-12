/**
 * Yahoo!ショッピング 問い合わせ受信アダプタの DB 非依存・ネットワーク非依存 単体テスト。
 *
 * - client の fetch を注入 (channels.config.__fetchImpl) してフェイク応答を返す。
 * - サンプル TalkList (20件で2ページ) + TalkDetail から fetchInbox が正しい
 *   NormalizedTicketWithMessages を yield することを検証。
 * - 1req/s throttle は vi.useFakeTimers で潰す (テストを遅くしない)。
 * - direction / status 丸めと channelMessageId 形式 ('talk:...') を assert。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { yahooAdapter } from '@/channels/yahoo/adapter';
import type {
  ChannelAdapterContext,
  AdapterLogger,
} from '@/channels/_lib/adapter';
import type { NormalizedTicketWithMessages } from '@/channels/_lib/types';

function makeLogger(): AdapterLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** 指定数の TalkList item を作る (page ごとに talkId をユニーク化)。 */
function makeListItems(page: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = (page - 1) * 20 + i + 1;
    return {
      talkId: `T${n}`,
      updateTime: '2026-06-12T10:00:00',
      status: n % 2 === 0 ? 'completed' : 'open',
      customerName: `Customer ${n}`,
      subject: `Subject ${n}`,
    };
  });
}

function makeDetail(talkId: string) {
  return {
    result: {
      talkId,
      status: 'open',
      customerName: `Customer ${talkId}`,
      subject: `Subject ${talkId}`,
      itemId: 'item-1',
      itemName: '商品A',
      orderId: 'order-1',
      messages: [
        {
          messageId: `${talkId}-m1`,
          body: '注文した商品はいつ届きますか',
          postTime: '2026-06-12T09:00:00',
          senderType: 'customer',
          senderName: '顧客',
        },
        {
          messageId: `${talkId}-m2`,
          body: '本日発送予定です',
          postTime: '2026-06-12T09:30:00',
          senderType: 'seller',
          senderName: '店舗',
        },
      ],
    },
  };
}

/**
 * フェイク fetch。URL の path を見て externalTalkList / externalTalkDetail を出し分ける。
 * - externalTalkList: page=1 → 20件, page=2 → 20件, page=3 → 0件 (終端)
 *   ※ 2ページ目も満杯(20件)なので、3ページ目を取得して空 → 終端で停止する経路を検証
 */
function makeFakeFetch() {
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input);
    const url = new URL(input);
    const json = (obj: unknown) =>
      new Response(JSON.stringify(obj), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.pathname.endsWith('/externalTalkList')) {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page === 1) return json({ result: makeListItems(1, 20), totalPage: 2 });
      if (page === 2) return json({ result: makeListItems(2, 20), totalPage: 2 });
      return json({ result: [], totalPage: 2 });
    }
    if (url.pathname.endsWith('/externalTalkDetail')) {
      const talkId = url.searchParams.get('talkId') ?? 'unknown';
      return json(makeDetail(talkId));
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

function makeCtx(fetchImpl: unknown, extraConfig: Record<string, unknown> = {}): ChannelAdapterContext {
  return {
    channel: {
      id: 'chan-yahoo-1',
      code: 'yahoo',
      config: { __fetchImpl: fetchImpl, ...extraConfig },
    },
    since: new Date('2026-06-12T00:00:00Z'),
    logger: makeLogger(),
    credentials: { access_token: 'fake-token-123' },
  };
}

async function collect(
  gen: AsyncGenerator<NormalizedTicketWithMessages, void, void>,
): Promise<NormalizedTicketWithMessages[]> {
  const out: NormalizedTicketWithMessages[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/**
 * fakeTimers 下で async generator を回すには、await した sleep の setTimeout を
 * 自動で進める必要がある。各 microtask 後に runAllTimers を呼ぶループで駆動する。
 */
async function drainWithFakeTimers(
  gen: AsyncGenerator<NormalizedTicketWithMessages, void, void>,
): Promise<NormalizedTicketWithMessages[]> {
  const out: NormalizedTicketWithMessages[] = [];
  let next = gen.next();
  // 各 next() は内部で sleep(setTimeout) を待つ可能性があるため、
  // pending timer を進めながら解決を待つ。
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // pending な microtask を 1 周させてから timer を進める。
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('2ページ(40件)を走査し全 talk を NormalizedTicketWithMessages として yield する', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl);

    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(ctx));

    // 40 talk yield された
    expect(results).toHaveLength(40);

    // totalPage=2 到達で終端 → list は page1, page2 の 2 回呼ばれる
    const listCalls = calls.filter((c) => c.includes('/externalTalkList'));
    expect(listCalls).toHaveLength(2);
    // detail は 40 回
    const detailCalls = calls.filter((c) => c.includes('/externalTalkDetail'));
    expect(detailCalls).toHaveLength(40);

    // since が updateTimeFrom として渡る
    expect(listCalls[0]).toContain('updateTimeFrom=');
  });

  it('direction / status 丸めと channelMessageId 形式を正しく map する', async () => {
    const { fetchImpl } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl);

    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(ctx));
    const first = results[0];

    // ticket
    expect(first.ticket.externalId).toBe('T1');
    expect(first.ticket.customerName).toBe('Customer T1');
    expect(first.ticket.subject).toBe('Subject T1');
    // detail.status = 'open' → untouched
    expect(first.ticket.status).toBe('untouched');
    expect(first.ticket.rawStatus).toBe('open');
    expect(first.ticket.channelMeta).toMatchObject({
      itemId: 'item-1',
      itemName: '商品A',
      orderId: 'order-1',
    });

    // messages: customer → inbound, seller → outbound
    expect(first.messages).toHaveLength(2);
    const [m1, m2] = first.messages;

    expect(m1.direction).toBe('inbound');
    expect(m1.senderType).toBe('customer');
    expect(m1.channelMessageId).toBe('talk:T1-m1');
    expect(m1.body).toBe('注文した商品はいつ届きますか');
    expect(m1.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(m2.direction).toBe('outbound');
    expect(m2.senderType).toBe('staff');
    expect(m2.channelMessageId).toBe('talk:T1-m2');
  });

  it('credentials が無ければ throw する', async () => {
    const { fetchImpl } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.credentials = {};

    const gen = yahooAdapter.fetchInbox(ctx);
    await expect(gen.next()).rejects.toThrow(/access token/i);
  });

  it('token フォールバック (credentials.token) を許容する', async () => {
    const { fetchImpl } = makeFakeFetch();
    const ctx = makeCtx(fetchImpl);
    ctx.credentials = { token: 'fallback-token' };

    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(ctx));
    expect(results.length).toBeGreaterThan(0);
  });

  it('detail 取得失敗時も throw せず最小 ticket を yield する (messages 空)', async () => {
    const failingFetch = async (input: string): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname.endsWith('/externalTalkList')) {
        const page = Number(url.searchParams.get('page') ?? '1');
        if (page === 1) {
          return new Response(
            JSON.stringify({ result: makeListItems(1, 3), totalPage: 1 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ result: [], totalPage: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // detail は常に 500
      return new Response('boom', { status: 500 });
    };
    const ctx = makeCtx(failingFetch);

    const results = await drainWithFakeTimers(yahooAdapter.fetchInbox(ctx));
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.messages).toHaveLength(0);
      expect(r.ticket.externalId).toMatch(/^T\d+$/);
    }
  });
});
