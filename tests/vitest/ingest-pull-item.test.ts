/**
 * pull 経路後処理 (ingestPullItem) の結線テスト (モック E2E)。
 *
 * 検証する不変条件:
 *  - 新規 inbound があるときだけ subject / draft を発火する。
 *  - outbound-only / 再送 (isNew=false) では一切発火しない。
 *  - subject 抑止 (既存件名の再要約回避) は resolver 内で判定するため、ここでは
 *    新規 inbound があれば常に resolveSubject を呼ぶ (gate の一元化)。
 *  - autoDraft=false (楽天) では draft を発火しない。
 *  - 複数新規 inbound では「最新 (sentAt 最大)」を素材にする。
 *  - channelMeta.subjectKind='review' は kind='review' で渡る。
 *  - subject / draft の例外、および一部メッセージの insert 失敗は握って warnings に積む
 *    (受信を壊さない / 残りメッセージは処理を継続)。
 */
import { describe, it, expect, vi } from 'vitest';
import { ingestPullItem } from '@/lib/sync/ingest-pull-item';
import type { NormalizedMessage } from '@/channels/_lib/types';

/** messages.insert を seen セットで擬似冪等化する fake Supabase。failKeys は非23505エラーを返す。 */
function makeFakeSb(seen = new Set<string>(), failKeys = new Set<string>()) {
  return {
    from(table: string) {
      if (table !== 'messages') {
        throw new Error(`unexpected table in test: ${table}`);
      }
      return {
        insert(row: { channel_message_id: string }) {
          const key = row.channel_message_id;
          if (failKeys.has(key)) return Promise.resolve({ error: { code: '500', message: 'boom' } });
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

const base = { channelId: 'ch-1', ticketId: 't-1', customerName: null };

describe('ingestPullItem — pull 後処理の結線', () => {
  it('新規 inbound + autoDraft → subject と draft を最新 inbound で発火', async () => {
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async (_sb: unknown, _args: unknown) => ({
      status: 'ingested_with_draft' as const,
      draftId: 'd1',
    }));
    const r = await ingestPullItem(makeFakeSb(), {
      ...base,
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
    expect(r.warnings).toHaveLength(0);
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
      autoDraft: true,
      messages: [outbound('talk:reply', '店舗回答', '2026-06-26T02:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(r.newInboundCount).toBe(0);
    expect(resolveSubject).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
  });

  it('新規 inbound があれば常に resolveSubject を呼ぶ (既存件名の抑止は resolver 内で判定)', async () => {
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async () => ({ status: 'ingested_with_draft' as const }));
    const r = await ingestPullItem(makeFakeSb(), {
      ...base,
      autoDraft: true,
      messages: [inbound('talk:1', '問い合わせ', '2026-06-26T01:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(r.subjectAttempted).toBe(true);
    expect(resolveSubject).toHaveBeenCalledTimes(1);
    expect(generateDraft).toHaveBeenCalledTimes(1);
  });

  it('autoDraft=false (楽天) → draft を発火しない (subject は発火)', async () => {
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async () => ({ status: 'ingested_with_draft' as const }));
    await ingestPullItem(makeFakeSb(), {
      ...base,
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
      autoDraft: true,
      messages: [inbound('talk:1', '問い合わせ', '2026-06-26T01:00:00Z')],
      resolveSubject,
      generateDraft,
    });
    expect(r.inserted).toBe(1);
    expect(r.warnings.some((w) => w.startsWith('subject:'))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('draft:'))).toBe(true);
  });

  it('一部メッセージの insert 失敗 (非23505) でも batch を中断せず、成功分で発火 (P3)', async () => {
    const failKeys = new Set<string>(['talk:bad']);
    const resolveSubject = vi.fn(async () => {});
    const generateDraft = vi.fn(async () => ({ status: 'ingested_with_draft' as const }));
    const r = await ingestPullItem(makeFakeSb(new Set(), failKeys), {
      ...base,
      autoDraft: true,
      messages: [
        inbound('talk:ok', '正常に入る問い合わせ', '2026-06-26T01:00:00Z'),
        inbound('talk:bad', 'insert 失敗するメッセージ', '2026-06-26T02:00:00Z'),
      ],
      resolveSubject,
      generateDraft,
    });
    // 失敗メッセージは新規扱いされず、成功した talk:ok で subject/draft が発火する
    expect(r.inserted).toBe(1);
    expect(r.newInboundCount).toBe(1);
    // 呼出側 (orchestrator/rakuten-sync) が cursor を保持するための signal
    expect(r.messageErrorCount).toBe(1);
    expect(r.warnings.some((w) => w.startsWith('message_insert_errors:'))).toBe(true);
    expect(resolveSubject).toHaveBeenCalledWith(expect.anything(), 't-1', {
      body: '正常に入る問い合わせ',
      kind: 'inquiry',
    });
    expect(generateDraft).toHaveBeenCalledTimes(1);
  });
});
