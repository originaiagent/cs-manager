/**
 * 共通 ingest (ingestInboundWithDraft) の DB 非依存 単体テスト
 *
 * codex 設計レビュー CONCERN#5 反映: email-ingest の抽出元ロジックの外部契約
 * (status 集合 / PII-safe DraftErrorCode / duplicate 挙動) を、実 DB に依存しない
 * フェイク SupabaseClient + 注入 RAG で pin する。抽出後もこの契約が不変であることを
 * 回帰ゲートにする。
 */
import { describe, it, expect, vi } from 'vitest';
import { ingestInboundWithDraft } from '@/lib/sync/ingest-inbound';
import type { RagReplyResult } from '@/lib/rag/reply-adapter';
import type { NormalizedTicket, NormalizedMessage } from '@/channels/_lib/types';

const TICKET_ID = 'ticket-uuid-001';
const DRAFT_ID = 'draft-uuid-001';

interface FakeOpts {
  existingTicket?: { id: string; status: string } | null;
  msgInsertError?: { code?: string; message?: string } | null;
  draftInsertError?: { message: string } | null;
}

/** ingestInboundWithDraft が叩く call chain だけを満たす最小フェイク。 */
function makeFakeSb(opts: FakeOpts) {
  const existing = opts.existingTicket ?? null;
  const msgErr = opts.msgInsertError ?? null;
  const draftErr = opts.draftInsertError ?? null;

  return {
    from(table: string) {
      if (table === 'tickets') {
        return {
          // upsertTicket(select → maybeSingle): 既存判定
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: existing, error: null }),
                single: () => Promise.resolve({ data: { id: TICKET_ID }, error: null }),
              }),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          upsert: () => Promise.resolve({ error: null }),
        };
      }
      if (table === 'messages') {
        // upsertMessageReturningNew: 素の insert を await
        return {
          insert: () => Promise.resolve({ error: msgErr }),
        };
      }
      if (table === 'ticket_drafts') {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve(
                  draftErr
                    ? { data: null, error: draftErr }
                    : { data: { id: DRAFT_ID }, error: null },
                ),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
}

const ticket: NormalizedTicket = {
  externalId: 'ext-1',
  status: 'untouched',
};
const inboundMessage: NormalizedMessage = {
  channelMessageId: 'inquiry:ext-1',
  direction: 'inbound',
  body: 'hello',
  sentAt: new Date(0).toISOString(),
};
const ragInput = { subject: 's', inquiryBody: 'b', customerName: null, channelId: 'ch-1', tenantId: null };

function reply(partial: Partial<RagReplyResult>): RagReplyResult {
  return { ok: true, ...partial } as RagReplyResult;
}

describe('ingestInboundWithDraft 外部契約', () => {
  it('新規 + RAG draft あり → ingested_with_draft + draftId', async () => {
    const gen = vi.fn(async () => reply({ ok: true, draft: 'お返事案', parseOk: true }));
    const sb = makeFakeSb({});
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_with_draft');
    expect(r.ticketId).toBe(TICKET_ID);
    expect(r.draftId).toBe(DRAFT_ID);
    expect(r.draftError).toBeUndefined();
    expect(gen).toHaveBeenCalledOnce();
  });

  it('重複 (message unique 23505) → duplicate, RAG 未呼出, draft 無し', async () => {
    const gen = vi.fn(async () => reply({ draft: 'x' }));
    const sb = makeFakeSb({ msgInsertError: { code: '23505' } });
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('duplicate');
    expect(r.draftId).toBeUndefined();
    expect(gen).not.toHaveBeenCalled();
  });

  it('RAG 例外 → ingested_draft_failed + rag_exception', async () => {
    const gen = vi.fn(async () => { throw new Error('network down with PII leak risk'); });
    const sb = makeFakeSb({});
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_draft_failed');
    expect(r.draftError).toBe('rag_exception');
    expect(r.draftId).toBeUndefined();
  });

  it('RAG 非OK → ingested_draft_failed + rag_upstream_error', async () => {
    const gen = vi.fn(async () => reply({ ok: false, error: 'raw upstream text' }));
    const sb = makeFakeSb({});
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_draft_failed');
    expect(r.draftError).toBe('rag_upstream_error');
  });

  it('RAG draft 空 (parseOk=true) → ingested_no_draft + rag_no_draft', async () => {
    const gen = vi.fn(async () => reply({ ok: true, draft: '   ', parseOk: true }));
    const sb = makeFakeSb({});
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_no_draft');
    expect(r.draftError).toBe('rag_no_draft');
  });

  it('parseOk 未設定 (ok:true だが parseOk なし) → fail-closed: rag_parse_failed, 保存しない', async () => {
    // 型上 parseOk は optional。未設定を「安全」とみなさず fail-closed にする (review P2)。
    const draftInsert = vi.fn();
    const gen = vi.fn(async () => reply({ ok: true, draft: '本文あり' })); // parseOk 欠落
    const sb = makeFakeSb({});
    const origFrom = sb.from.bind(sb);
    sb.from = (table: string) => {
      if (table === 'ticket_drafts') {
        return {
          insert: (...args: unknown[]) => {
            draftInsert(...args);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: DRAFT_ID }, error: null }) }) };
          },
        };
      }
      return origFrom(table);
    };
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_no_draft');
    expect(r.draftError).toBe('rag_parse_failed');
    expect(draftInsert).not.toHaveBeenCalled();
  });

  it('構造分離失敗 (parseOk=false) → ingested_no_draft + rag_parse_failed, 混在 body は保存しない', async () => {
    // reply-adapter は parseOk=false 時 draft='' を返す。万一 draft に値が来ても保存しない。
    const draftInsert = vi.fn();
    const gen = vi.fn(async () =>
      reply({ ok: true, draft: '', internalPreview: '混在テキスト全文', parseOk: false }),
    );
    const sb = makeFakeSb({});
    // insert が呼ばれないことを検証するため ticket_drafts.insert を spy 化
    const origFrom = sb.from.bind(sb);
    sb.from = (table: string) => {
      if (table === 'ticket_drafts') {
        return {
          insert: (...args: unknown[]) => {
            draftInsert(...args);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: DRAFT_ID }, error: null }) }) };
          },
        };
      }
      return origFrom(table);
    };
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_no_draft');
    expect(r.draftError).toBe('rag_parse_failed');
    expect(r.draftId).toBeUndefined();
    // 混在 body は ticket_drafts に絶対 insert されない
    expect(draftInsert).not.toHaveBeenCalled();
  });

  it('parseOk=true の AI draft → is_separated=true で保存される', async () => {
    const draftInsert = vi.fn();
    const gen = vi.fn(async () =>
      reply({ ok: true, draft: '顧客向け本文', parseOk: true }),
    );
    const sb = makeFakeSb({});
    const origFrom = sb.from.bind(sb);
    sb.from = (table: string) => {
      if (table === 'ticket_drafts') {
        return {
          insert: (row: Record<string, unknown>) => {
            draftInsert(row);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: DRAFT_ID }, error: null }) }) };
          },
        };
      }
      return origFrom(table);
    };
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_with_draft');
    expect(draftInsert).toHaveBeenCalledOnce();
    expect(draftInsert.mock.calls[0][0]).toMatchObject({ is_separated: true, body: '顧客向け本文' });
  });

  it('draft 保存失敗 → ingested_draft_failed + draft_persist_error', async () => {
    const gen = vi.fn(async () => reply({ ok: true, draft: '案', parseOk: true }));
    const sb = makeFakeSb({ draftInsertError: { message: 'insert failed' } });
    const r = await ingestInboundWithDraft(sb, { channelId: 'ch-1', ticket, inboundMessage, ragInput, generateReply: gen });
    expect(r.status).toBe('ingested_draft_failed');
    expect(r.draftError).toBe('draft_persist_error');
  });
});
