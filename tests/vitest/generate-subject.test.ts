/**
 * generateSubject 単体テスト (DB 非依存 / runEmbed 注入)
 *
 * テスト対象: src/lib/subject/generate-subject.ts
 *
 * 検証観点:
 *  - 正常系: origin-ai が {subject} を返すとき trim + 120 文字 cap して返す
 *  - 失敗系: ok:false / result.subject 不正 / 空 → fallback (既定 null) を返す
 *  - 上限: >120 文字は 120 文字にキャップ
 *  - never throw: runEmbed が throw しても例外を伝播させない
 *  - ガード: body / ticketId が空のとき runEmbed を呼ばずフォールバック
 */

import { describe, it, expect } from 'vitest';
import { generateSubject } from '@/lib/subject/generate-subject';
import type { EmbedOneshotResult } from '@/lib/embed/run-oneshot';

const TICKET_ID = 'ticket-uuid-001';
const BODY = '返品したい商品があります';

/** runEmbed モック生成ヘルパ */
function makeRun(result: EmbedOneshotResult) {
  return async (_args: unknown): Promise<EmbedOneshotResult> => result;
}

describe('generateSubject', () => {
  it('(a) 正常系: subject を trim して返す', async () => {
    const run = makeRun({ ok: true, result: { subject: '  返品について  ' } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBe('返品について');
  });

  it('(a) subject に先頭末尾空白がないときそのまま返す', async () => {
    const run = makeRun({ ok: true, result: { subject: '返品について' } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBe('返品について');
  });

  it('(b) ok:false → null (デフォルト fallback)', async () => {
    const run = makeRun({ ok: false, reason: 'embed_key_unprovisioned' });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBeNull();
  });

  it('(b) ok:false + fallback 指定 → fallback を返す', async () => {
    const run = makeRun({ ok: false, reason: 'embed_run_start_404' });
    const r = await generateSubject({
      body: BODY,
      ticketId: TICKET_ID,
      runEmbed: run,
      fallback: '問い合わせ件名',
    });
    expect(r).toBe('問い合わせ件名');
  });

  it('(c) result.subject が非 string (number) → null', async () => {
    const run = makeRun({ ok: true, result: { subject: 42 as unknown as string } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBeNull();
  });

  it('(c) result.subject が null → null', async () => {
    const run = makeRun({ ok: true, result: { subject: null as unknown as string } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBeNull();
  });

  it('(c) result.subject が空文字 → null', async () => {
    const run = makeRun({ ok: true, result: { subject: '' } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBeNull();
  });

  it('(c) result.subject が空白のみ → null', async () => {
    const run = makeRun({ ok: true, result: { subject: '   ' } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBeNull();
  });

  it('(c) result が null (ok:true だが result なし) → null', async () => {
    const run = makeRun({ ok: true, result: undefined });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBeNull();
  });

  it('(d) 120 文字を超える subject → 120 文字にキャップ', async () => {
    const longSubject = 'あ'.repeat(130);
    const run = makeRun({ ok: true, result: { subject: longSubject } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).not.toBeNull();
    expect(r!.length).toBe(120);
    expect(r).toBe('あ'.repeat(120));
  });

  it('(d) ちょうど 120 文字の subject → そのまま返す', async () => {
    const subject = 'あ'.repeat(120);
    const run = makeRun({ ok: true, result: { subject } });
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBe(subject);
  });

  it('(e) runEmbed が throw → null を返す (例外を伝播させない)', async () => {
    const run = async (): Promise<EmbedOneshotResult> => {
      throw new Error('network error with PII customer data');
    };
    // generateSubject は throw しない = Promise が reject されない
    const r = await generateSubject({ body: BODY, ticketId: TICKET_ID, runEmbed: run });
    expect(r).toBeNull();
  });

  it('(e) runEmbed が throw + fallback 指定 → fallback を返す', async () => {
    const run = async (): Promise<EmbedOneshotResult> => {
      throw new Error('upstream error');
    };
    const r = await generateSubject({
      body: BODY,
      ticketId: TICKET_ID,
      runEmbed: run,
      fallback: '商品に関するお問い合わせ',
    });
    expect(r).toBe('商品に関するお問い合わせ');
  });

  it('body が空 → runEmbed を呼ばずに fallback を返す', async () => {
    const run = async (): Promise<EmbedOneshotResult> => {
      throw new Error('should not be called');
    };
    const r = await generateSubject({
      body: '',
      ticketId: TICKET_ID,
      runEmbed: run,
      fallback: 'fallback',
    });
    expect(r).toBe('fallback');
  });

  it('ticketId が空 → runEmbed を呼ばずに null を返す', async () => {
    const run = async (): Promise<EmbedOneshotResult> => {
      throw new Error('should not be called');
    };
    const r = await generateSubject({ body: BODY, ticketId: '', runEmbed: run });
    expect(r).toBeNull();
  });
});
