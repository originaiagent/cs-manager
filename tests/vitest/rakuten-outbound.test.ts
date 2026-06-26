/**
 * 楽天 R-MessE 店舗送信 (outbound) 取り込み検証テスト
 *
 * 目的: R-MessE の replies[] (店舗側返信) が fetchInbox を通じて
 *   1 inbound + N outbound のメッセージ配列に変換されることを検証する。
 *
 * アプローチ: adapter.ts の内部 mapper 関数 (toInboundMessage / toOutboundMessage) は
 *   エクスポートされていないため、以下をモックして rakutenAdapter.fetchInbox を通して検証する:
 *   - @/lib/credentials → getCredential (ネットワーク不要)
 *   - @/channels/rakuten/client → RakutenInquiryClient (ネットワーク不要)
 *
 * これは "契約テスト" として機能する:
 *   - listInquiries / getInquiry の応答スキーマ → NormalizedMessage の変換契約を担保
 *   - channel_message_id フォーマット規約 'reply:<id>' / 'inquiry:<inquiryNumber>' を固定
 *   - (ticket_id, channel_message_id) UNIQUE を支える idempotency を確認
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { ChannelAdapterContext, AdapterLogger } from '@/channels/_lib/adapter';
import type { NormalizedTicketWithMessages } from '@/channels/_lib/types';
import type { RakutenInquiry } from '@/channels/rakuten/types';

// ─── モック設定 ────────────────────────────────────────────────────────────────

// getCredential をモック (Core API への HTTP 呼び出しを排除)
vi.mock('@/lib/credentials', () => ({
  getCredential: vi.fn().mockResolvedValue({
    service_code: 'rakuten_rmesse',
    scope_key: 'test-shop',
    credentials: { serviceSecret: 'fake-secret', licenseKey: 'fake-key' },
    metadata: {},
    valid_from: '2026-01-01T00:00:00Z',
    valid_to: null,
  }),
}));

// RakutenInquiryClient をモック (楽天 API への HTTP 呼び出しを排除)
// 各テストで mockClient を差し替えるため、変数参照を使う
let mockListInquiries = vi.fn();
let mockGetInquiry = vi.fn();

vi.mock('@/channels/rakuten/client', () => {
  return {
    RakutenInquiryClient: vi.fn().mockImplementation(() => ({
      listInquiries: (...args: unknown[]) => mockListInquiries(...args),
      getInquiry: (...args: unknown[]) => mockGetInquiry(...args),
    })),
    RakutenApiError: class RakutenApiError extends Error {
      constructor(
        message: string,
        public readonly status: number,
        public readonly body: string,
      ) {
        super(message);
        this.name = 'RakutenApiError';
      }
    },
  };
});

// adapter はモック後にインポート (vi.mock は巻き上げられるため順序不問だが明示する)
import { rakutenAdapter } from '@/channels/rakuten/adapter';

// ─── テストフィクスチャ ──────────────────────────────────────────────────────────

function makeLogger(): AdapterLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ChannelAdapterContext> = {}): ChannelAdapterContext {
  return {
    channel: {
      id: 'ch-rakuten-test',
      code: 'rakuten',
      config: {
        shop_id: 'test-shop',
        api_base: 'https://api.rms.rakuten.co.jp/es/1.0/inquirymng-api',
        // page_limit と request_delay_ms を短縮してテストを高速化
        page_limit: 100,
        request_delay_ms: 0,
        lookback_minutes: 15,
      },
    },
    since: null,
    logger: makeLogger(),
    ...overrides,
  };
}

/**
 * 問い合わせ 1 件 + 返信 N 件のフィクスチャ
 */
function makeInquiry(overrides: Partial<RakutenInquiry> = {}): RakutenInquiry {
  return {
    inquiryNumber: 'INQ-001',
    userName: 'テスト太郎',
    userMaskEmail: 'test@example.com',
    message: '商品について質問があります',
    regDate: '2026-06-01T10:00:00',
    isCompleted: false,
    replies: [
      {
        id: 1001,
        message: '本日発送いたします',
        regDate: '2026-06-01T11:00:00',
      },
      {
        id: 1002,
        message: '追跡番号をご連絡します',
        regDate: '2026-06-01T12:00:00',
      },
    ],
    ...overrides,
  };
}

/**
 * fetchInbox ジェネレータをすべて drain して配列で返す。
 * テスト内では request_delay_ms=0 なので sleep は即返る。
 */
async function drainFetchInbox(
  ctx: ChannelAdapterContext,
): Promise<NormalizedTicketWithMessages[]> {
  const out: NormalizedTicketWithMessages[] = [];
  for await (const item of rakutenAdapter.fetchInbox(ctx)) {
    out.push(item);
  }
  return out;
}

// ─── テスト ──────────────────────────────────────────────────────────────────────

describe('rakutenAdapter.fetchInbox — 店舗送信 (outbound) 取り込み', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルト: 1 ページ 1 件
    const inq = makeInquiry();
    mockListInquiries.mockResolvedValue({
      totalCount: 1,
      totalPageCount: 1,
      page: 1,
      list: [inq],
    });
    mockGetInquiry.mockResolvedValue({ result: inq });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('replies[] を持つ問い合わせは 1 inbound + 2 outbound を生成する', async () => {
    const results = await drainFetchInbox(makeCtx());

    expect(results).toHaveLength(1);

    const { ticket, messages } = results[0];

    // チケット: external_id = inquiryNumber
    expect(ticket.externalId).toBe('INQ-001');
    expect(ticket.status).toBe('untouched'); // isCompleted=false

    // メッセージ構成: inbound 1 + outbound 2 = 計 3
    expect(messages).toHaveLength(3);

    // ── inbound (顧客の問い合わせ本文) ──────────────────────────────
    const inbound = messages.filter((m) => m.direction === 'inbound');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].channelMessageId).toBe('inquiry:INQ-001');
    expect(inbound[0].senderType).toBe('customer');
    expect(inbound[0].body).toBe('商品について質問があります');
    expect(inbound[0].sentAt).toMatch(/^2026-06-01T/);

    // ── outbound (店舗側返信) ──────────────────────────────────────
    const outbound = messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(2);

    // channelMessageId フォーマット: 'reply:<reply.id>'
    expect(outbound[0].channelMessageId).toBe('reply:1001');
    expect(outbound[0].senderType).toBe('staff');
    expect(outbound[0].body).toBe('本日発送いたします');
    expect(outbound[0].sentAt).toMatch(/^2026-06-01T/);

    expect(outbound[1].channelMessageId).toBe('reply:1002');
    expect(outbound[1].senderType).toBe('staff');
    expect(outbound[1].body).toBe('追跡番号をご連絡します');
  });

  it('replies が空の問い合わせは inbound 1 件のみを生成する', async () => {
    const inq = makeInquiry({ replies: [] });
    mockListInquiries.mockResolvedValue({ totalCount: 1, totalPageCount: 1, page: 1, list: [inq] });
    mockGetInquiry.mockResolvedValue({ result: inq });

    const results = await drainFetchInbox(makeCtx());
    expect(results).toHaveLength(1);
    expect(results[0].messages).toHaveLength(1);
    expect(results[0].messages[0].direction).toBe('inbound');
  });

  it('replies が undefined の問い合わせは inbound 1 件のみを生成する (replies フィールド欠落)', async () => {
    const inq = makeInquiry({ replies: undefined });
    mockListInquiries.mockResolvedValue({ totalCount: 1, totalPageCount: 1, page: 1, list: [inq] });
    mockGetInquiry.mockResolvedValue({ result: inq });

    const results = await drainFetchInbox(makeCtx());
    expect(results).toHaveLength(1);
    expect(results[0].messages).toHaveLength(1);
    expect(results[0].messages[0].direction).toBe('inbound');
  });

  it('2 回実行しても channel_message_id が変わらない (冪等性)', async () => {
    const run1 = await drainFetchInbox(makeCtx());
    const run2 = await drainFetchInbox(makeCtx());

    const ids1 = run1[0].messages.map((m) => m.channelMessageId).sort();
    const ids2 = run2[0].messages.map((m) => m.channelMessageId).sort();

    // 両実行で完全一致 → (ticket_id, channel_message_id) UNIQUE に対して冪等に upsert 可能
    expect(ids1).toEqual(ids2);
    // 期待値を明示
    expect(ids1).toEqual(['inquiry:INQ-001', 'reply:1001', 'reply:1002']);
  });

  it('isCompleted=true の問い合わせは status=done でマッピングされる', async () => {
    const inq = makeInquiry({ isCompleted: true, completedDate: '2026-06-02T09:00:00' });
    mockListInquiries.mockResolvedValue({ totalCount: 1, totalPageCount: 1, page: 1, list: [inq] });
    mockGetInquiry.mockResolvedValue({ result: inq });

    const results = await drainFetchInbox(makeCtx());
    expect(results[0].ticket.status).toBe('done');
    expect(results[0].ticket.rawStatus).toBe('completed');
  });

  it('outbound の channelMessageId が reply:<numeric_id> 形式を維持する (DB UNIQUE KEY 契約)', async () => {
    // upsertMessages の onConflict: 'ticket_id,channel_message_id' が重複排除に使う形式
    const results = await drainFetchInbox(makeCtx());
    const outbound = results[0].messages.filter((m) => m.direction === 'outbound');

    for (const msg of outbound) {
      // 'reply:' プレフィックス + 数値 ID の形式であること
      expect(msg.channelMessageId).toMatch(/^reply:\d+$/);
    }
  });

  it('shop_id が config に無い場合は throw する', async () => {
    const ctx = makeCtx({
      channel: {
        id: 'ch-rakuten-test',
        code: 'rakuten',
        config: { api_base: 'https://api.rms.example.com', request_delay_ms: 0 },
        // shop_id 欠落
      },
    });

    await expect(drainFetchInbox(ctx)).rejects.toThrow(/shop_id/);
  });
});
