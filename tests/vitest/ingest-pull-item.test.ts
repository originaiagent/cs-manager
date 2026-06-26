/**
 * pull 経路後処理 (ingestPullItem) の結線テスト (モック E2E)。
 *
 * 検証する不変条件:
 *  - 新規 inbound があるときだけ subject / draft を発火する。
 *  - outbound-only / 再送 (isNew=false) では一切発火しない。
 *  - subject は subjectEmpty=true のときだけ呼ぶ (無駄な origin-ai 呼出回避)。
 *  - autoDraft=false (楽天) では draft を発火しない。
 *  - 複数新規 inbound では「最新 (sentAt 最大)」を素材にする。
 *  - channelMeta.subjectKind='review' は kind='review' で渡る。
 *  - subject / draft の例外は握って warnings に積む (受信を壊さない)。
 */
import { describe, it, expect, vi } from 'vitest';
import { ingestPullItem } from '@/lib/sync/ingest-pull-item';
import type { NormalizedMessage } from '@/channels/_lib/types';

/** messages.insert を seen セットで擬似冪等化する fake Supabase。 */
function makeFakeSb(seen = new Set<string>()) {
  return {
    from(table: string) {
      if (table !== 'messages') {
        throw new Error(`unexpected table in test: ${table}`);
      }
      return {
        insert(row: { channel_message_id: string }) {
          const key = row.channel_message_id;
          if (seen.has(key)) return Promise.resolve({ error: { code: '23505' } });
          seen.add(key);
          return Promise.resolve({ error: null });
        },
      };
    },
  } as any;
}

function inbound(id: string, body: string, sentAt: string): NormalizedMessage {
  return { channelMessageId: id, direction: 'inbound', body, senderType: 'customer', sentAt };
}
function outbound(id: string, body: string, sentAt: string): NormalizedMessage {
  return { channelMessageId: id, direction: 'outbound', body, senderType: 'staff', sentAt };
}

const base = {
  channelId: 'ch-1',
  ticketId: 't-1',
  customerName: null,
};

describe('ingestPullItem — pull 後処理の結線', () => {
  it('新規 inbound + subjectEmpty + autoDraft → subject と draft を最新 inbound で発火', async () => {
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async (_sb: unknown, _args: unknown) => ({
      status: 'ingested_with_draft' as const,
      draftId: 'd1',
    }));
    const r = await ingestPullItem(makeFakeSb(), {
      ...base,
      subjectEmpty: true,
      autoDraft: true,
      messages: [
        inbound('talk:1', '古い問い合わせ', '2026-06-26T01:00:00Z'),
        inbound('talk:2', '最新の返品依頼', '2026-06-26T03:00:00Z'),
        outbound('talk:reply', '店舗回答', '2026-06-26T02:00:00Z'),
      ],
      resolveSubject,
      generateDraft,
    });

    expect(r.inserted).toBe(3);
    expect(r.newInboundCount).toBe(2);
    expect(r.subjectAttempted).toBe(true);
    expect(r.draftStatus).toBe('ingested_with_draft');
    // 最新 inbound (03:00 の talk:2) を素材にする
    expect(resolveSubject).toHaveBeenCalledTimes(1);
    expect(resolveSubject).toHaveBeenCalledWith(expect.anything(), 't-1', {
      body: '最新の返品依頼',
      kind: 'inquiry',
    });
    expect(generateDraft).toHaveBeenCalledTimes(1);
    expect(generateDraft.mock.calls[0][1]).toMatchObject({ inboundBody: '最新の返品依頼', ticketId: 't-1' });
  });

  it('outbound のみ新規 → subject も draft も発火しない', async () => {
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async () => ({ status: 'ingested_with_draft' as const }));
    const r = await ingestPullItem(makeFakeSb(), {
      ...base,
      subjectEmpty: true,
      autoDraft: true,
      messages: [outbound('talk:reply', '店舗回答', '2026-06-26T02:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(r.newInboundCount).toBe(0);
    expect(resolveSubject).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('subjectEmpty=false → subject を呼ばない (draft は autoDraft に従う)', async () => {
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async () => ({ status: 'ingested_with_draft' as const }));
    const r = await ingestPullItem(makeFakeSb(), {
      ...base,
      subjectEmpty: false,
      autoDraft: true,
      messages: [inbound('talk:1', '問い合わせ', '2026-06-26T01:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(r.subjectAttempted).toBe(false);
    expect(resolveSubject).not.toHaveBeenCalled();
    expect(generateDraft).toHaveBeenCalledTimes(1);
  });

  it('autoDraft=false (楽天) → draft を発火しない (subject は発火)', async () => {
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async () => ({ status: 'ingested_with_draft' as const }));
    await ingestPullItem(makeFakeSb(), {
      ...base,
      subjectEmpty: true,
      autoDraft: false,
      messages: [inbound('inquiry:1', '楽天問い合わせ', '2026-06-26T01:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(resolveSubject).toHaveBeenCalledTimes(1);
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('再送 (全て既知 channel_message_id) → 新規 inbound 0 → 非発火・冪等', async () => {
    const seen = new Set<string>(['inquiry:1']);
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async () => ({ status: 'ingested_with_draft' as const }));
    const r = await ingestPullItem(makeFakeSb(seen), {
      ...base,
      subjectEmpty: true,
      autoDraft: true,
      messages: [inbound('inquiry:1', '同じ問い合わせ', '2026-06-26T01:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(r.inserted).toBe(0);
    expect(r.newInboundCount).toBe(0);
    expect(resolveSubject).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('channelMeta.subjectKind=review → kind=review で渡る', async () => {
    const resolveSubject = vi.fn(async () => {});
    await ingestPullItem(makeFakeSb(), {
      ...base,
      subjectEmpty: true,
      autoDraft: false,
      channelMeta: { subjectKind: 'review' },
      messages: [inbound('talk:1', 'レビューへの返信', '2026-06-26T01:00:00Z')],
      resolveSubject,
    });
    expect(resolveSubject).toHaveBeenCalledWith(expect.anything(), 't-1', {
      body: 'レビューへの返信',
      kind: 'review',
    });
  });

  it('subject / draft が例外を投げても受信は壊さず warnings に積む', async () => {
    const resolveSubject = vi.fn(async () => {
      throw new Error('boom-subject');
    });
    const generateDraft = vi.fn(async () => {
      throw new Error('boom-draft');
    });
    const r = await ingestPullItem(makeFakeSb(), {
      ...base,
      subjectEmpty: true,
      autoDraft: true,
      messages: [inbound('talk:1', '問い合わせ', '2026-06-26T01:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(r.inserted).toBe(1);
    expect(r.warnings.some((w) => w.startsWith('subject:'))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('draft:'))).toBe(true);
  });
});
