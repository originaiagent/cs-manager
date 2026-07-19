/**
 * runDefectClassification の origin-ai embed 経路 (CLASSIFY_VIA_EMBED=true 明示指定) テスト。
 *
 * 検証:
 *  - embed 経路 (CLASSIFY_VIA_EMBED=true) で runEmbedOneshotAndPoll を正しい引数
 *    (slug/targetType/targetId=ticketId/input.categories 等) で呼ぶこと
 *    (defect-classify-run.test.ts は legacy 固定なので別ファイル化)
 *  - CLASSIFY_VIA_EMBED='false' (=既定) で invokeChat 直呼びのままであること (embed/legacy 両分岐)
 *  - embed 失敗時は classify_attempts を再更新しない (attempts はクレーム時加算済のまま。契約不変)
 *  - embed 応答の形状不正は分類失敗 (fail-closed) として扱われる
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const runEmbedOneshotAndPollMock = vi.fn();
vi.mock('@/lib/embed/run-oneshot', () => ({
  runEmbedOneshotAndPoll: (...args: unknown[]) => runEmbedOneshotAndPollMock(...args),
}));

const invokeChatMock = vi.fn();
vi.mock('@/lib/ai-client', () => ({
  invokeChat: (...args: unknown[]) => invokeChatMock(...args),
}));

const maskTextMock = vi.fn();
const resolveRagInternalKeyMock = vi.fn();
vi.mock('@/lib/first-response/mask', () => ({
  maskText: (...args: unknown[]) => maskTextMock(...args),
  resolveRagInternalKey: () => resolveRagInternalKeyMock(),
}));

vi.mock('@/lib/product-resolver', () => ({
  resolveProductsByIds: async () => new Map(),
}));

import { runDefectClassification } from '@/lib/quality/defect-classify';
import type { SupabaseClient } from '@supabase/supabase-js';

const TICKET_ID = '1e4d461c-0000-4000-8000-000000000001';

function makeFakeSb(opts: {
  claimed: Array<{ id: string; subject: string | null; product_id: string | null; classify_attempts: number }>;
}) {
  const ticketUpdates: Array<Record<string, unknown>> = [];
  const claimQueue = [...opts.claimed];

  const sb = {
    rpc: (name: string, params: unknown) => {
      if (name === 'claim_defect_classify_batch') {
        const limit = (params as { p_limit?: number }).p_limit ?? 1;
        return Promise.resolve({ data: claimQueue.splice(0, limit), error: null });
      }
      if (name === 'top_defect_cause_labels') {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    },
    from: (table: string) => {
      if (table === 'rag_config') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: { body: 'water leaks from the unit' }, error: null }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'ticket_defect_causes') {
        return {
          select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
          upsert: () => Promise.resolve({ error: null }),
        };
      }
      if (table === 'customer_service_records') {
        return {
          select: () => ({
            or: () => ({ not: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
          }),
        };
      }
      if (table === 'tickets') {
        return {
          update: (payload: Record<string, unknown>) => {
            ticketUpdates.push(payload);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { sb, ticketUpdates };
}

const TICKET = {
  id: TICKET_ID,
  subject: 'ミラーの件',
  product_id: null,
  classify_attempts: 1,
};

const OLD_CLASSIFY_VIA_EMBED = process.env.CLASSIFY_VIA_EMBED;

beforeEach(() => {
  process.env.CLASSIFY_VIA_EMBED = 'true'; // 既定は legacy に変わったため、embed 経路のテストは明示的にONにする
  runEmbedOneshotAndPollMock.mockReset();
  runEmbedOneshotAndPollMock.mockResolvedValue({
    ok: true,
    result: {
      category: 'defect',
      causes: [{ label: 'ミラー表面に傷あり', major_category: 'damaged' }],
    },
  });
  invokeChatMock.mockReset();
  maskTextMock.mockReset();
  maskTextMock.mockImplementation(async (_key: string, text: string) => ({
    maskedText: text,
    maskFailed: false,
  }));
  resolveRagInternalKeyMock.mockReset();
  resolveRagInternalKeyMock.mockResolvedValue('test-internal-key');
});

afterEach(() => {
  // process.env.X = undefined は文字列 "undefined" になってしまうため、元が未設定なら delete する。
  if (OLD_CLASSIFY_VIA_EMBED === undefined) {
    delete process.env.CLASSIFY_VIA_EMBED;
  } else {
    process.env.CLASSIFY_VIA_EMBED = OLD_CLASSIFY_VIA_EMBED;
  }
  vi.restoreAllMocks();
});

describe('runDefectClassification: embed 経路 (CLASSIFY_VIA_EMBED=true)', () => {
  it('正しい slug/targetType/targetId(=ticketId)/input で runEmbedOneshotAndPoll を1本だけ呼ぶ', async () => {
    const { sb, ticketUpdates } = makeFakeSb({ claimed: [TICKET] });
    const result = await runDefectClassification(sb);

    expect(result.classified).toBe(1);
    expect(invokeChatMock).not.toHaveBeenCalled();
    expect(runEmbedOneshotAndPollMock).toHaveBeenCalledTimes(1);
    const call = runEmbedOneshotAndPollMock.mock.calls[0][0];
    expect(call.slug).toBe('cs:classify-defect');
    expect(call.targetType).toBe('customer_record');
    expect(call.targetId).toBe(TICKET_ID);
    expect(call.input.inquiry_masked).toContain('water leaks from the unit');
    expect(call.input.categories).toEqual(['defect', 'shipping', 'usage', 'other']);
    expect(ticketUpdates[0]).toMatchObject({ case_category: 'defect', defect_type: 'damaged' });
  });

  it('CLASSIFY_VIA_EMBED=false で invokeChat 直呼び (legacy) へ即時復帰する (embed/legacy 両分岐)', async () => {
    process.env.CLASSIFY_VIA_EMBED = 'false';
    invokeChatMock.mockResolvedValue({
      ok: true,
      structuredOutput: { category: 'defect', causes: [{ label: '傷あり', major_category: 'damaged' }] },
      message: '',
    });
    const { sb } = makeFakeSb({ claimed: [TICKET] });
    const result = await runDefectClassification(sb);

    expect(result.classified).toBe(1);
    expect(runEmbedOneshotAndPollMock).not.toHaveBeenCalled();
    expect(invokeChatMock).toHaveBeenCalledTimes(1);
  });

  it('embed 失敗 (ok:false) は分類失敗として扱い、classify_attempts を再更新しない (契約不変)', async () => {
    runEmbedOneshotAndPollMock.mockResolvedValue({ ok: false, reason: 'embed_run_poll_deadline' });
    const { sb, ticketUpdates } = makeFakeSb({ claimed: [TICKET] });
    const result = await runDefectClassification(sb);

    expect(result.failed).toBe(1);
    expect(result.classified).toBe(0);
    expect(ticketUpdates).toHaveLength(0);
  });

  it('embed 応答の形状不正 (category 欠落) は分類失敗 (fail-closed) として扱う', async () => {
    runEmbedOneshotAndPollMock.mockResolvedValue({ ok: true, result: { causes: [] } });
    const { sb, ticketUpdates } = makeFakeSb({ claimed: [TICKET] });
    const result = await runDefectClassification(sb);

    expect(result.failed).toBe(1);
    expect(ticketUpdates).toHaveLength(0);
  });

  it('embed 応答の causes が4件超過 (形状不正) は分類失敗として扱う', async () => {
    runEmbedOneshotAndPollMock.mockResolvedValue({
      ok: true,
      result: {
        category: 'defect',
        causes: Array.from({ length: 4 }, (_, i) => ({ label: `症状${i}`, major_category: 'other' })),
      },
    });
    const { sb, ticketUpdates } = makeFakeSb({ claimed: [TICKET] });
    const result = await runDefectClassification(sb);

    expect(result.failed).toBe(1);
    expect(ticketUpdates).toHaveLength(0);
  });
});
