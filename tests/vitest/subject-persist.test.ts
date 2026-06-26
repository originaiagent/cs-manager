/**
 * resolveAndPersistSubject 単体テスト (DB 非依存 / runEmbed 注入)
 *
 * テスト対象: src/lib/subject/generate-subject.ts — resolveAndPersistSubject
 *
 * 検証観点 (codex PR review P1+P2 反映後):
 *  - 既存 subject が空 (NULL) → origin-ai 要約 → update(.is('subject', null)) optimistic-lock。
 *  - 既存 subject が空 ('' 空文字) → update(.eq('subject', '')) で確実に更新 (P1)。
 *  - 既存 subject が非空 → origin-ai を呼ばず update もしない (P2: 無駄回避 / clobber 防止)。
 *  - generateSubject が null (ok:false) → update を呼ばない。
 *  - body 空 → select も update もしない (origin-ai を呼ばない)。
 *  - DB / runEmbed の例外を握り、外へ投げない。
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveAndPersistSubject } from '@/lib/subject/generate-subject';
import type { EmbedOneshotResult } from '@/lib/embed/run-oneshot';

const TICKET_ID = 'ticket-uuid-001';
const BODY = '返品したい商品があります';

function makeSuccessRun(subject: string) {
  return vi.fn(async (): Promise<EmbedOneshotResult> => ({ ok: true, result: { subject } }));
}
function makeFailRun() {
  return vi.fn(async (): Promise<EmbedOneshotResult> => ({ ok: false, reason: 'embed_key_unprovisioned' }));
}

/**
 * tickets テーブルの select(現 subject 読取) + update(optimistic-lock) チェーンをスパイする
 * フェイク SupabaseClient。`current` で「読んだ時点の subject」を制御する。
 */
function makeFakeSb(opts: {
  current?: string | null;
  updateError?: { code?: string } | null;
  selectError?: { code?: string } | null;
} = {}) {
  const current = opts.current === undefined ? null : opts.current;
  const maybeSingle = vi.fn().mockResolvedValue({ data: { subject: current }, error: opts.selectError ?? null });
  const selectEq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: selectEq });

  const updateResult = { error: opts.updateError ?? null };
  const isMock = vi.fn().mockResolvedValue(updateResult); // .is('subject', null)
  const eqSubjectMock = vi.fn().mockResolvedValue(updateResult); // .eq('subject', oldVal)
  const updateEqId = vi.fn().mockReturnValue({ is: isMock, eq: eqSubjectMock });
  const update = vi.fn().mockReturnValue({ eq: updateEqId });

  const from = vi.fn().mockReturnValue({ select, update });
  return {
    sb: { from } as unknown as Parameters<typeof resolveAndPersistSubject>[0],
    from, select, update, selectEq, maybeSingle, updateEqId, isMock, eqSubjectMock,
  };
}

describe('resolveAndPersistSubject', () => {
  it('既存 subject=NULL → 要約 → update が .is("subject", null) ガード付きで呼ばれる', async () => {
    const f = makeFakeSb({ current: null });
    const runEmbed = makeSuccessRun('返品について');

    await resolveAndPersistSubject(f.sb, TICKET_ID, { body: BODY, runEmbed });

    expect(f.from).toHaveBeenCalledWith('tickets');
    expect(runEmbed).toHaveBeenCalledOnce();
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.update.mock.calls[0][0]).toEqual({ subject: '返品について' });
    expect(f.updateEqId).toHaveBeenCalledWith('id', TICKET_ID);
    expect(f.isMock).toHaveBeenCalledWith('subject', null);
    expect(f.eqSubjectMock).not.toHaveBeenCalled();
  });

  it('既存 subject="" (空文字) → update が .eq("subject", "") で確実に更新される (P1)', async () => {
    const f = makeFakeSb({ current: '' });
    const runEmbed = makeSuccessRun('返品について');

    await resolveAndPersistSubject(f.sb, TICKET_ID, { body: BODY, runEmbed });

    expect(runEmbed).toHaveBeenCalledOnce();
    expect(f.update).toHaveBeenCalledOnce();
    // optimistic-lock は読んだ空値 '' に厳密一致 (NULL ガードではなく eq('subject','') を使う)
    expect(f.eqSubjectMock).toHaveBeenCalledWith('subject', '');
    expect(f.isMock).not.toHaveBeenCalled();
  });

  it('既存 subject が非空 → origin-ai を呼ばず update もしない (P2)', async () => {
    const f = makeFakeSb({ current: '既存の件名' });
    const runEmbed = makeSuccessRun('上書きしてはいけない');

    await resolveAndPersistSubject(f.sb, TICKET_ID, { body: BODY, runEmbed });

    expect(runEmbed).not.toHaveBeenCalled(); // 既に件名あり → 要約を呼ばない
    expect(f.update).not.toHaveBeenCalled(); // clobber しない
  });

  it('generateSubject null (ok:false) → update を呼ばない', async () => {
    const f = makeFakeSb({ current: null });
    await resolveAndPersistSubject(f.sb, TICKET_ID, { body: BODY, runEmbed: makeFailRun() });
    expect(f.update).not.toHaveBeenCalled();
  });

  it('fallback 指定時: ok:false でも fallback が non-null なら update が呼ばれる', async () => {
    const f = makeFakeSb({ current: null });
    await resolveAndPersistSubject(f.sb, TICKET_ID, {
      body: BODY,
      runEmbed: makeFailRun(),
      fallback: '商品に関するお問い合わせ',
    });
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.update.mock.calls[0][0]).toEqual({ subject: '商品に関するお問い合わせ' });
  });

  it('body が空 → select も update もしない (origin-ai を呼ばない)', async () => {
    const f = makeFakeSb({ current: null });
    const runEmbed = makeSuccessRun('返品について');
    await resolveAndPersistSubject(f.sb, TICKET_ID, { body: '', runEmbed });
    expect(f.select).not.toHaveBeenCalled();
    expect(runEmbed).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it('DB update がエラーを返しても例外を投げない', async () => {
    const f = makeFakeSb({ current: null, updateError: { code: '42P01' } });
    await expect(
      resolveAndPersistSubject(f.sb, TICKET_ID, { body: BODY, runEmbed: makeSuccessRun('返品について') }),
    ).resolves.toBeUndefined();
  });

  it('select がエラーを返したら何もせず例外も投げない', async () => {
    const f = makeFakeSb({ current: null, selectError: { code: '42P01' } });
    const runEmbed = makeSuccessRun('返品について');
    await expect(
      resolveAndPersistSubject(f.sb, TICKET_ID, { body: BODY, runEmbed }),
    ).resolves.toBeUndefined();
    expect(runEmbed).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it('runEmbed が throw しても例外を投げない・update を呼ばない', async () => {
    const f = makeFakeSb({ current: null });
    const throwRun = async (): Promise<EmbedOneshotResult> => {
      throw new Error('upstream catastrophic failure with customer PII');
    };
    await expect(
      resolveAndPersistSubject(f.sb, TICKET_ID, { body: BODY, runEmbed: throwRun }),
    ).resolves.toBeUndefined();
    expect(f.update).not.toHaveBeenCalled();
  });
});
