/**
 * resolveAndPersistSubject 単体テスト (DB 非依存 / runEmbed 注入)
 *
 * テスト対象: src/lib/subject/generate-subject.ts — resolveAndPersistSubject
 *
 * 検証観点:
 *  - generateSubject が non-null → tickets.update().eq('id', ticketId).is('subject', null) を呼ぶ
 *  - generateSubject が null (ok:false) → update を呼ばない
 *  - DB update がエラーを返しても例外を投げない
 *  - 全体として例外を伝播させない (defense-in-depth)
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveAndPersistSubject } from '@/lib/subject/generate-subject';
import type { EmbedOneshotResult } from '@/lib/embed/run-oneshot';

const TICKET_ID = 'ticket-uuid-001';
const BODY = '返品したい商品があります';

function makeSuccessRun(subject: string) {
  return async (): Promise<EmbedOneshotResult> => ({ ok: true, result: { subject } });
}

function makeFailRun() {
  return async (): Promise<EmbedOneshotResult> => ({
    ok: false,
    reason: 'embed_key_unprovisioned',
  });
}

/** tickets.update().eq().is() チェーン全体をスパイするフェイク SupabaseClient 生成 */
function makeFakeSb(updateError?: { code?: string; message?: string } | null) {
  const err = updateError ?? null;
  const isMock = vi.fn().mockResolvedValue({ error: err });
  const eqMock = vi.fn().mockReturnValue({ is: isMock });
  const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
  const fromMock = vi.fn().mockReturnValue({ update: updateMock });

  return {
    sb: { from: fromMock } as unknown as Parameters<typeof resolveAndPersistSubject>[0],
    fromMock,
    updateMock,
    eqMock,
    isMock,
  };
}

describe('resolveAndPersistSubject', () => {
  it('generateSubject non-null → update が .is("subject", null) ガード付きで呼ばれる', async () => {
    const { sb, fromMock, updateMock, eqMock, isMock } = makeFakeSb();

    await resolveAndPersistSubject(sb, TICKET_ID, {
      body: BODY,
      runEmbed: makeSuccessRun('返品について'),
    });

    // tickets テーブルに from を呼んでいること
    expect(fromMock).toHaveBeenCalledWith('tickets');

    // update の引数: { subject: '返品について' }
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock.mock.calls[0][0]).toEqual({ subject: '返品について' });

    // eq の引数: ('id', TICKET_ID)
    expect(eqMock).toHaveBeenCalledWith('id', TICKET_ID);

    // is の引数: ('subject', null) — 冪等ロック確認
    expect(isMock).toHaveBeenCalledWith('subject', null);
  });

  it('generateSubject null (ok:false) → update を呼ばない', async () => {
    const { sb, updateMock } = makeFakeSb();

    await resolveAndPersistSubject(sb, TICKET_ID, {
      body: BODY,
      runEmbed: makeFailRun(),
    });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('fallback 指定時: ok:false でも fallback が non-null なら update が呼ばれる', async () => {
    const { sb, updateMock } = makeFakeSb();

    await resolveAndPersistSubject(sb, TICKET_ID, {
      body: BODY,
      runEmbed: makeFailRun(),
      fallback: '商品に関するお問い合わせ',
    });

    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateMock.mock.calls[0][0]).toEqual({ subject: '商品に関するお問い合わせ' });
  });

  it('body が空 → update を呼ばない', async () => {
    const { sb, updateMock } = makeFakeSb();

    await resolveAndPersistSubject(sb, TICKET_ID, {
      body: '',
      runEmbed: makeSuccessRun('返品について'),
    });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('DB update がエラーを返しても例外を投げない', async () => {
    const { sb } = makeFakeSb({ code: '42P01', message: 'table not found' });

    // 例外が throw されないこと (Promise が reject されないこと)
    await expect(
      resolveAndPersistSubject(sb, TICKET_ID, {
        body: BODY,
        runEmbed: makeSuccessRun('返品について'),
      }),
    ).resolves.toBeUndefined();
  });

  it('runEmbed が throw しても例外を投げない', async () => {
    const { sb, updateMock } = makeFakeSb();

    const throwRun = async (): Promise<EmbedOneshotResult> => {
      throw new Error('upstream catastrophic failure with customer PII');
    };

    await expect(
      resolveAndPersistSubject(sb, TICKET_ID, {
        body: BODY,
        runEmbed: throwRun,
      }),
    ).resolves.toBeUndefined();

    // throw した場合も update は呼ばない
    expect(updateMock).not.toHaveBeenCalled();
  });
});
