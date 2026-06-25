/**
 * LINE 返信 mock E2E: 受信 webhook → 正規化 → (承認済 draft) → 送信 API 呼び出し。
 *
 * 実キー無しで通せる範囲を 1 本に束ねる結線証明:
 *   (1) 署名検証 (channel_secret) → 受信認可
 *   (2) normalize で push 宛先 userId を ticket.channel_meta に取り込む
 *   (3) 承認済 draft を sendApprovedLineDrafts が push: payload 正当性 (to/text/Bearer/retryKey)
 *   (4) 二重送信防止 (claim → 2 回目は送らない)
 *   (5) 認証 Core 解決 (getCredential('line_messaging', scope_key) → Bearer に反映)
 *
 * 実 push 着信・実 Core 鍵・実 embed はトムのキー投入 + Webhook 登録後の人間ゲート。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyLineSignature } from '@/channels/line/verify';
import { isTextMessageEvent, normalizeLineTextEvent } from '@/channels/line/normalize';
import {
  sendApprovedLineDrafts,
  type LineDraftRepo,
  type ClaimedLineDraft,
  type LineChannelRow,
} from '@/channels/line/outbound';
import { LineMessagingClient } from '@/channels/line/client';
import type { AdapterLogger } from '@/channels/_lib/adapter';

const noopLogger: AdapterLogger = { info: () => {}, warn: () => {}, error: () => {} };
const channel: LineChannelRow = {
  id: 'ch-line',
  code: 'line',
  config: { scope_key: 'CID-123', service_code: 'line_messaging' },
};

class E2EFakeRepo implements LineDraftRepo {
  state = new Map<string, { status: string; body: string; ticketId: string; toUserId: string | null; ext?: string }>();
  outbound: Array<{ ticketId: string; channelMessageId: string; body: string }> = [];
  constructor(seed: Array<{ id: string; body: string; ticketId: string; toUserId: string | null }>) {
    for (const d of seed) this.state.set(d.id, { status: 'approved', ...d });
  }
  async reclaimStaleSending() {
    return { released: 0, failed: 0 };
  }
  async claimApprovedDrafts(_c: string, limit: number): Promise<ClaimedLineDraft[]> {
    const claimed = [...this.state.entries()].filter(([, d]) => d.status === 'approved').slice(0, limit);
    claimed.forEach(([, d]) => (d.status = 'sending'));
    return claimed.map(([id, d]) => ({ id, body: d.body, ticketId: d.ticketId, toUserId: d.toUserId }));
  }
  async markSent(id: string, ext: string) {
    const d = this.state.get(id)!;
    d.status = 'sent';
    d.ext = ext;
  }
  async markFailed(id: string) {
    this.state.get(id)!.status = 'failed';
  }
  async releaseToApproved(id: string) {
    this.state.get(id)!.status = 'approved';
  }
  async upsertOutboundMessage(ticketId: string, channelMessageId: string, body: string) {
    this.outbound.push({ ticketId, channelMessageId, body });
  }
}

describe('LINE 返信 mock E2E (受信→承認→送信)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('署名検証→正規化→承認draft→push payload正当性→二重送信防止', async () => {
    // (1) 受信: 署名検証
    const CHANNEL_SECRET = 'e2e-channel-secret';
    const userId = 'Udeadbeefdeadbeefdeadbeefdeadbeef';
    const webhookBody = {
      destination: 'Udestination',
      events: [
        {
          type: 'message',
          message: { id: 'msg-100', type: 'text', text: '注文をキャンセルしたいです' },
          source: { type: 'user', userId },
          timestamp: 1_700_000_000_000,
          replyToken: 'reply-token-ephemeral',
        },
      ],
    };
    const raw = JSON.stringify(webhookBody);
    const sig = createHmac('sha256', CHANNEL_SECRET).update(raw, 'utf8').digest('base64');
    expect(verifyLineSignature(raw, sig, CHANNEL_SECRET)).toBe(true);
    expect(verifyLineSignature(raw, sig, 'wrong')).toBe(false);

    // (2) 正規化: push 宛先 userId が channel_meta に入る
    const ev = webhookBody.events[0];
    expect(isTextMessageEvent(ev)).toBe(true);
    const { ticket, inboundMessage } = normalizeLineTextEvent(ev, channel.id);
    expect((ticket.channelMeta as any).userId).toBe(userId);
    expect(inboundMessage.channelMessageId).toBe('line:msg-100');

    // (3) 承認済 draft (ingest→embed→承認 は別テストで担保。ここでは承認済を seed)
    const draftId = '11111111-2222-3333-4444-555555555555';
    const draftBody = 'お問い合わせありがとうございます。キャンセル手続きを承りました。';
    const repo = new E2EFakeRepo([
      { id: draftId, body: draftBody, ticketId: 'ticket-1', toUserId: (ticket.channelMeta as any).userId },
    ]);

    // 実 client に mock fetch を注入し push リクエストを捕捉
    let captured: { url: any; init: any } | null = null;
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'access-tok' },
      fetchImpl: (async (url: any, init: any) => {
        captured = { url, init };
        return new Response(JSON.stringify({ sentMessages: [{ id: 'sent-1' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const p = sendApprovedLineDrafts(channel, noopLogger, { repo, client });
    await vi.runAllTimersAsync();
    const res = await p;

    // (3) payload 正当性
    expect(res.succeeded).toBe(1);
    expect(captured!.url).toBe('https://api.line.me/v2/bot/message/push');
    expect(captured!.init.headers.Authorization).toBe('Bearer access-tok');
    expect(captured!.init.headers['X-Line-Retry-Key']).toBe(draftId); // 冪等鍵=draftId
    expect(JSON.parse(captured!.init.body)).toEqual({
      to: userId,
      messages: [{ type: 'text', text: draftBody }],
    });
    expect(repo.state.get(draftId)!.status).toBe('sent');
    expect(repo.state.get(draftId)!.ext).toBe('line:sent-1');
    expect(repo.outbound).toEqual([
      { ticketId: 'ticket-1', channelMessageId: `line-reply:${draftId}`, body: draftBody },
    ]);

    // (4) 二重送信防止: 2 回目は approved が無く送らない
    const p2 = sendApprovedLineDrafts(channel, noopLogger, { repo, client });
    await vi.runAllTimersAsync();
    const res2 = await p2;
    expect(res2.attempted).toBe(0);
  });

  it('認証 Core 解決: getCredential(line_messaging, scope_key) の token が Bearer に反映', async () => {
    const credMod = await import('@/lib/credentials');
    const spy = vi
      .spyOn(credMod, 'getCredential')
      .mockResolvedValue({
        service_code: 'line_messaging',
        scope_key: 'CID-123',
        credentials: { channel_access_token: 'core-resolved-token' },
        metadata: {},
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
      } as any);

    // client を渡さない → 実 getCredential 経路でヘッダ構築。fetch は global を stub。
    let auth: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        auth = init.headers.Authorization;
        return new Response(JSON.stringify({ sentMessages: [{ id: 's' }] }), { status: 200 });
      }),
    );

    const repo = new E2EFakeRepo([{ id: 'd-1', body: 'x', ticketId: 't', toUserId: 'Uxxxxxxxx' }]);
    const p = sendApprovedLineDrafts(channel, noopLogger, { repo });
    await vi.runAllTimersAsync();
    await p;

    expect(spy).toHaveBeenCalledWith('line_messaging', 'CID-123');
    expect(auth).toBe('Bearer core-resolved-token');
  });
});
