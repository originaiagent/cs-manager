/**
 * pull-auto-draft (generateDraftForNewInbound) 単体テスト
 *
 * DB / ネットワーク非依存。generateReply を注入し、
 * ingestInboundWithDraft の draft 生成ハーフと同一 fail-closed 規律を pin する。
 *
 * 確認事項:
 *  (a) ok + parseOk + nonempty draft → ticket_drafts insert (source='rag', is_separated=true), ingested_with_draft
 *  (b) parseOk=false → no insert, ingested_no_draft / rag_parse_failed
 *  (c) empty draft (parseOk=true) → no insert, ingested_no_draft / rag_no_draft
 *  (d) !ok → ingested_draft_failed / rag_upstream_error
 *  (e) generateReply throws → ingested_draft_failed / rag_exception (no throw)
 */
import { describe, it, expect, vi } from 'vitest';
import { generateDraftForNewInbound } from '@/lib/sync/pull-auto-draft';
import type { RagReplyResult } from '@/lib/rag/reply-adapter';

const TICKET_ID = 'ticket-pull-001';
const DRAFT_ID = 'draft-pull-001';

// ---------- フェイク Supabase クライアント ----------

interface FakeSbOpts {
  draftInsertError?: { message: string } | null;
  /** ticket_drafts.insert の引数を記録するスパイ */
  draftInsertSpy?: ReturnType<typeof vi.fn>;
}

function makeFakeSb(opts: FakeSbOpts = {}) {
  const draftErr = opts.draftInsertError ?? null;
  const spy = opts.draftInsertSpy;

  return {
    from(table: string) {
      if (table === 'ticket_drafts') {
        return {
          insert(row: Record<string, unknown>) {
            if (spy) spy(row);
            return {
              select: () => ({
                single: () =>
                  Promise.resolve(
                    draftErr
                      ? { data: null, error: draftErr }
                      : { data: { id: DRAFT_ID }, error: null },
                  ),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as any;
}

// ---------- ヘルパ ----------

function ragOk(partial: Partial<RagReplyResult>): RagReplyResult {
  return { ok: true, ...partial } as RagReplyResult;
}

const BASE_ARGS = {
  channelId: 'ch-yahoo-1',
  ticketId: TICKET_ID,
  inboundBody: '注文した商品はいつ届きますか',
  customerName: 'テスト太郎',
  productId: 'prod-abc',
};

// ---------- テスト ----------

describe('generateDraftForNewInbound', () => {
  it('(a) ok + parseOk=true + nonempty draft → ticket_drafts insert (source=rag, is_separated=true), ingested_with_draft', async () => {
    const draftInsertSpy = vi.fn();
    const gen = vi.fn(async () => ragOk({ draft: 'お返事案です', parseOk: true }));
    const sb = makeFakeSb({ draftInsertSpy });

    const result = await generateDraftForNewInbound(sb, { ...BASE_ARGS, generateReply: gen });

    expect(result.status).toBe('ingested_with_draft');
    expect(result.draftId).toBe(DRAFT_ID);
    expect(result.draftError).toBeUndefined();
    expect(gen).toHaveBeenCalledOnce();
    // ticket_drafts に正しいフィールドで insert される
    expect(draftInsertSpy).toHaveBeenCalledOnce();
    expect(draftInsertSpy.mock.calls[0][0]).toMatchObject({
      ticket_id: TICKET_ID,
      body: 'お返事案です',
      source: 'rag',
      is_separated: true,
    });
  });

  it('(b) parseOk=false → no insert, ingested_no_draft + rag_parse_failed', async () => {
    const draftInsertSpy = vi.fn();
    // reply-adapter が parseOk=false の場合 draft='' を返すが、万一 draft に値があっても保存しない
    const gen = vi.fn(async () => ragOk({ draft: '', internalPreview: '混在本文', parseOk: false }));
    const sb = makeFakeSb({ draftInsertSpy });

    const result = await generateDraftForNewInbound(sb, { ...BASE_ARGS, generateReply: gen });

    expect(result.status).toBe('ingested_no_draft');
    expect(result.draftError).toBe('rag_parse_failed');
    expect(result.draftId).toBeUndefined();
    // ticket_drafts へ insert しない (fail-closed)
    expect(draftInsertSpy).not.toHaveBeenCalled();
  });

  it('(b-2) parseOk 未設定 (ok:true だが parseOk なし) → fail-closed: rag_parse_failed', async () => {
    const draftInsertSpy = vi.fn();
    // parseOk フィールド自体が undefined (欠落)
    const gen = vi.fn(async () => ({ ok: true, draft: '本文あり' } as RagReplyResult));
    const sb = makeFakeSb({ draftInsertSpy });

    const result = await generateDraftForNewInbound(sb, { ...BASE_ARGS, generateReply: gen });

    expect(result.status).toBe('ingested_no_draft');
    expect(result.draftError).toBe('rag_parse_failed');
    expect(draftInsertSpy).not.toHaveBeenCalled();
  });

  it('(c) empty draft (parseOk=true) → no insert, ingested_no_draft + rag_no_draft', async () => {
    const draftInsertSpy = vi.fn();
    const gen = vi.fn(async () => ragOk({ draft: '   ', parseOk: true }));
    const sb = makeFakeSb({ draftInsertSpy });

    const result = await generateDraftForNewInbound(sb, { ...BASE_ARGS, generateReply: gen });

    expect(result.status).toBe('ingested_no_draft');
    expect(result.draftError).toBe('rag_no_draft');
    expect(result.draftId).toBeUndefined();
    expect(draftInsertSpy).not.toHaveBeenCalled();
  });

  it('(d) !ok → ingested_draft_failed + rag_upstream_error', async () => {
    const draftInsertSpy = vi.fn();
    const gen = vi.fn(async () => ({ ok: false, error: 'upstream_raw_message' } as RagReplyResult));
    const sb = makeFakeSb({ draftInsertSpy });

    const result = await generateDraftForNewInbound(sb, { ...BASE_ARGS, generateReply: gen });

    expect(result.status).toBe('ingested_draft_failed');
    expect(result.draftError).toBe('rag_upstream_error');
    expect(result.draftId).toBeUndefined();
    expect(draftInsertSpy).not.toHaveBeenCalled();
  });

  it('(e) generateReply throws → ingested_draft_failed + rag_exception (no throw)', async () => {
    const draftInsertSpy = vi.fn();
    const gen = vi.fn(async () => {
      throw new Error('network error with PII risk');
    });
    const sb = makeFakeSb({ draftInsertSpy });

    // 例外が外に伝播しないことを確認
    await expect(generateDraftForNewInbound(sb, { ...BASE_ARGS, generateReply: gen })).resolves.toMatchObject({
      status: 'ingested_draft_failed',
      draftError: 'rag_exception',
    });
    expect(draftInsertSpy).not.toHaveBeenCalled();
  });

  it('draft DB insert 失敗 → ingested_draft_failed + draft_persist_error', async () => {
    const gen = vi.fn(async () => ragOk({ draft: '案', parseOk: true }));
    const sb = makeFakeSb({ draftInsertError: { message: 'insert failed' } });

    const result = await generateDraftForNewInbound(sb, { ...BASE_ARGS, generateReply: gen });

    expect(result.status).toBe('ingested_draft_failed');
    expect(result.draftError).toBe('draft_persist_error');
    expect(result.draftId).toBeUndefined();
  });

  it('ragInput に subject:null / channelId / ticketId / customerName / productId が渡される', async () => {
    let capturedInput: unknown;
    const gen = vi.fn(async (_sb: unknown, input: unknown) => {
      capturedInput = input;
      return ragOk({ draft: '案', parseOk: true });
    });
    const sb = makeFakeSb({});

    await generateDraftForNewInbound(sb, {
      channelId: 'ch-yahoo-99',
      ticketId: 'ticket-xyz',
      inboundBody: '問い合わせ内容',
      customerName: '山田太郎',
      productId: 'prod-99',
      generateReply: gen,
    });

    expect(capturedInput).toMatchObject({
      subject: null,
      inquiryBody: '問い合わせ内容',
      customerName: '山田太郎',
      channelId: 'ch-yahoo-99',
      tenantId: null,
      ticketId: 'ticket-xyz',
      productId: 'prod-99',
    });
  });

  it('customerName / productId 省略時は null で渡される', async () => {
    let capturedInput: unknown;
    const gen = vi.fn(async (_sb: unknown, input: unknown) => {
      capturedInput = input;
      return ragOk({ draft: '案', parseOk: true });
    });
    const sb = makeFakeSb({});

    await generateDraftForNewInbound(sb, {
      channelId: 'ch-yahoo-1',
      ticketId: 'ticket-abc',
      inboundBody: '質問',
      generateReply: gen,
    });

    expect(capturedInput).toMatchObject({
      customerName: null,
      productId: null,
    });
  });
});
