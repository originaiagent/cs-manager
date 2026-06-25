/**
 * LINE 送信 outbound 単体テスト。
 *
 * (a) 純関数: isValidPushUserId / extractRawUserId / buildExternalMessageId
 * (b) orchestration sendApprovedLineDrafts: fake repo + 実 client(fetch 注入) で
 *     状態遷移と二重送信防止・分類を検証。backoff/遅延 sleep は fake timers で即時化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendApprovedLineDrafts,
  isValidPushUserId,
  extractRawUserId,
  resolvePushUserId,
  buildExternalMessageId,
  type LineDraftRepo,
  type ClaimedLineDraft,
  type LineChannelRow,
} from '@/channels/line/outbound';
import { LineMessagingClient } from '@/channels/line/client';
import type { AdapterLogger } from '@/channels/_lib/adapter';
import type { LinePushResult } from '@/channels/line/types';

// ---------------------------------------------------------------------------
// 純関数
// ---------------------------------------------------------------------------
describe('isValidPushUserId', () => {
  it("'U' 始まりの非空文字のみ true", () => {
    expect(isValidPushUserId('U1234')).toBe(true);
    expect(isValidPushUserId('Uabc')).toBe(true);
    expect(isValidPushUserId(null)).toBe(false);
    expect(isValidPushUserId('')).toBe(false);
    expect(isValidPushUserId('C123')).toBe(false); // group
    expect(isValidPushUserId('R123')).toBe(false); // room
    expect(isValidPushUserId('U')).toBe(false); // too short
  });
});

describe('extractRawUserId', () => {
  it('channel_meta.userId を取り出す', () => {
    expect(extractRawUserId({ userId: 'U1' })).toBe('U1');
    expect(extractRawUserId({ userId: null })).toBeNull();
    expect(extractRawUserId({})).toBeNull();
    expect(extractRawUserId(null)).toBeNull();
    expect(extractRawUserId('nope')).toBeNull();
  });
});

describe('resolvePushUserId (source.type=user の 1:1 のみ)', () => {
  it('source.type=user + 有効 userId → userId', () => {
    expect(resolvePushUserId({ sourceType: 'user', userId: 'U_abc' })).toBe('U_abc');
  });
  it('group/room は sender userId があっても null (private 誤送防止)', () => {
    expect(resolvePushUserId({ sourceType: 'group', userId: 'U_sender' })).toBeNull();
    expect(resolvePushUserId({ sourceType: 'room', userId: 'U_sender' })).toBeNull();
  });
  it('sourceType 欠落 / userId 欠落 / 非 U は null', () => {
    expect(resolvePushUserId({ userId: 'U_abc' })).toBeNull();
    expect(resolvePushUserId({ sourceType: 'user' })).toBeNull();
    expect(resolvePushUserId({ sourceType: 'user', userId: 'C_grp' })).toBeNull();
    expect(resolvePushUserId(null)).toBeNull();
  });
});

describe('buildExternalMessageId', () => {
  const base: LinePushResult = {
    status: 200,
    sentMessageId: null,
    acceptedRequestId: null,
    requestId: null,
    rawBody: '',
  };
  it('sentMessages.id を最優先', () => {
    expect(buildExternalMessageId({ ...base, sentMessageId: 'm9' }, 'd1')).toBe('line:m9');
  });
  it('409 は accepted-request-id、無ければ draftId fallback', () => {
    expect(buildExternalMessageId({ ...base, status: 409, acceptedRequestId: 'a9' }, 'd1')).toBe(
      'line-accepted:a9',
    );
    expect(buildExternalMessageId({ ...base, status: 409 }, 'd1')).toBe('line-retry-conflict:d1');
  });
  it('2xx で id 無しは request-id、無ければ draftId fallback', () => {
    expect(buildExternalMessageId({ ...base, requestId: 'r9' }, 'd1')).toBe('line-req:r9');
    expect(buildExternalMessageId({ ...base }, 'd1')).toBe('line-sent:d1');
  });
});

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------
interface DraftState {
  id: string;
  status: string;
  body: string;
  ticketId: string;
  toUserId: string | null;
  externalMessageId?: string | null;
  sentAt?: string | null;
  lastError?: string | null;
}

class FakeRepo implements LineDraftRepo {
  drafts = new Map<string, DraftState>();
  outbound: Array<{ ticketId: string; channelMessageId: string; body: string }> = [];
  claimCalls = 0;
  throwOnMarkSent = false;

  constructor(initial: DraftState[]) {
    for (const d of initial) this.drafts.set(d.id, { ...d });
  }
  async reclaimStaleSending() {
    return { released: 0, failed: 0 };
  }
  async claimApprovedDrafts(_channelId: string, limit: number): Promise<ClaimedLineDraft[]> {
    this.claimCalls += 1;
    const claimed = [...this.drafts.values()].filter((d) => d.status === 'approved').slice(0, limit);
    claimed.forEach((d) => (d.status = 'sending'));
    return claimed.map((d) => ({ id: d.id, body: d.body, ticketId: d.ticketId, toUserId: d.toUserId }));
  }
  async markSent(draftId: string, externalMessageId: string, sentAtIso: string) {
    if (this.throwOnMarkSent) throw new Error('db down');
    const d = this.drafts.get(draftId)!;
    d.status = 'sent';
    d.externalMessageId = externalMessageId;
    d.sentAt = sentAtIso;
    d.lastError = null;
  }
  async markFailed(draftId: string, error: string) {
    const d = this.drafts.get(draftId)!;
    d.status = 'failed';
    d.lastError = error;
  }
  async releaseToApproved(draftId: string, error: string) {
    const d = this.drafts.get(draftId)!;
    d.status = 'approved';
    d.lastError = error;
  }
  async upsertOutboundMessage(ticketId: string, channelMessageId: string, body: string) {
    this.outbound.push({ ticketId, channelMessageId, body });
  }
}

const channel: LineChannelRow = { id: 'ch-line', code: 'line', config: { scope_key: 'CID', service_code: 'line_messaging' } };
const noopLogger: AdapterLogger = { info: () => {}, warn: () => {}, error: () => {} };

function clientReturning(responder: () => Response): LineMessagingClient {
  return new LineMessagingClient({
    credentials: { channel_access_token: 'tok' },
    fetchImpl: (async () => responder()) as unknown as typeof fetch,
  });
}

function draft(id: string, over: Partial<DraftState> = {}): DraftState {
  return { id, status: 'approved', body: 'reply body', ticketId: `t-${id}`, toUserId: 'U_user_1', ...over };
}

/** fake timers 下で sendApprovedLineDrafts を完走させる。 */
async function runSend(repo: LineDraftRepo, client: LineMessagingClient) {
  const p = sendApprovedLineDrafts(channel, noopLogger, { repo, client });
  await vi.runAllTimersAsync();
  return p;
}

describe('sendApprovedLineDrafts orchestration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('200 → sent + external_message_id + outbound message', async () => {
    const repo = new FakeRepo([draft('d1')]);
    const client = clientReturning(() =>
      new Response(JSON.stringify({ sentMessages: [{ id: 'mm1' }] }), { status: 200 }),
    );
    const res = await runSend(repo, client);

    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(0);
    const d = repo.drafts.get('d1')!;
    expect(d.status).toBe('sent');
    expect(d.externalMessageId).toBe('line:mm1');
    expect(d.sentAt).toBeTruthy();
    expect(repo.outbound).toEqual([
      { ticketId: 't-d1', channelMessageId: 'line-reply:d1', body: 'reply body' },
    ]);
  });

  it('409 (retry-key 既受理) → sent 扱い', async () => {
    const repo = new FakeRepo([draft('d1')]);
    const client = clientReturning(() =>
      new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'acc-1' } }),
    );
    const res = await runSend(repo, client);
    expect(res.succeeded).toBe(1);
    expect(repo.drafts.get('d1')!.status).toBe('sent');
    expect(repo.drafts.get('d1')!.externalMessageId).toBe('line-accepted:acc-1');
  });

  it('userId 欠落/不正 → failed (送信せず)', async () => {
    const repo = new FakeRepo([draft('d1', { toUserId: null }), draft('d2', { toUserId: 'C_group' })]);
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await runSend(repo, client);
    expect(res.failed).toBe(2);
    expect(repo.drafts.get('d1')!.status).toBe('failed');
    expect(repo.drafts.get('d2')!.status).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled(); // push しない (誤爆防止)
  });

  it('恒久 4xx (403) → failed (再送しない)', async () => {
    const repo = new FakeRepo([draft('d1')]);
    const client = clientReturning(() => new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 }));
    const res = await runSend(repo, client);
    expect(res.failed).toBe(1);
    expect(repo.drafts.get('d1')!.status).toBe('failed');
  });

  it('429 月間上限 → failed (再送しない)', async () => {
    const repo = new FakeRepo([draft('d1')]);
    const client = clientReturning(
      () => new Response(JSON.stringify({ message: 'You have reached your monthly limit.' }), { status: 429 }),
    );
    const res = await runSend(repo, client);
    expect(res.failed).toBe(1);
    expect(repo.drafts.get('d1')!.status).toBe('failed');
  });

  it('429 rate-limit → backoff 尽きて approved に戻す (transient)', async () => {
    const repo = new FakeRepo([draft('d1')]);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 }));
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const res = await runSend(repo, client);
    expect(res.failed).toBe(1);
    expect(repo.drafts.get('d1')!.status).toBe('approved'); // 次 cron で再送
    expect(fetchSpy).toHaveBeenCalledTimes(4); // 初回 + backoff 3 回
  });

  it('network/timeout (配信不明) → approved に戻さず sending のまま (24hガード維持 codex P2)', async () => {
    const repo = new FakeRepo([draft('d1')]);
    const client = new LineMessagingClient({
      credentials: { channel_access_token: 'tok' },
      fetchImpl: (async () => {
        throw Object.assign(new Error('reset'), { name: 'TypeError' });
      }) as unknown as typeof fetch,
    });
    const res = await runSend(repo, client);
    expect(res.failed).toBe(1);
    // 配信したか不明なため 'sending' のまま (reclaim が 15m-24h→再送→409 / >24h→failed で収束)。
    expect(repo.drafts.get('d1')!.status).toBe('sending');
  });

  it('配信成功後のDB記録失敗は approved に戻さず sending のまま (二重配信防止 codex P2)', async () => {
    const repo = new FakeRepo([draft('d1')]);
    repo.throwOnMarkSent = true;
    const client = clientReturning(() =>
      new Response(JSON.stringify({ sentMessages: [{ id: 'mm1' }] }), { status: 200 }),
    );
    const res = await runSend(repo, client);
    expect(res.failed).toBe(1);
    // 配信済なので approved に戻さない (retry-key 失効後の再配信を避ける)。
    expect(repo.drafts.get('d1')!.status).toBe('sending');
    // outbound message は markSent 前に記録済 (audit 欠落しない / codex P2)。
    expect(repo.outbound).toHaveLength(1);
    expect(repo.outbound[0].channelMessageId).toBe('line-reply:d1');
  });

  it('二重送信防止: claim で sending 化、再 claim で approved が無く送らない', async () => {
    const repo = new FakeRepo([draft('d1')]);
    const client = clientReturning(() => new Response(JSON.stringify({ sentMessages: [{ id: 'mm1' }] }), { status: 200 }));
    await runSend(repo, client);
    expect(repo.drafts.get('d1')!.status).toBe('sent');
    // 2 回目: approved が残っていないので送信対象 0
    const res2 = await runSend(repo, client);
    expect(res2.attempted).toBe(0);
    expect(res2.succeeded).toBe(0);
  });
});
