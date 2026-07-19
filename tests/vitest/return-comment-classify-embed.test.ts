/**
 * runReturnCommentClassification の origin-ai embed 経路 (CLASSIFY_VIA_EMBED=true 明示指定) テスト。
 *
 * 検証:
 *  - embed 経路 (CLASSIFY_VIA_EMBED=true) で runEmbedOneshotAndPoll を正しい引数
 *    (slug='cs:classify-return-comment' / targetType='fba_return' / targetId=return_key(fbaReturnKey) /
 *    input={comment_masked, existing_labels} のみ) で呼ぶこと
 *  - CLASSIFY_VIA_EMBED='false' (=既定) で invokeChat 直呼び (legacy) のままであること (embed/legacy 両分岐)
 *  - symptoms:[] (症状なし) は正常成功として classified_at のみ設定すること
 *  - embed 失敗時は classified_at を設定しない (attempts はクレーム時加算済のまま。契約不変)
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

const fetchCustomerReturnsMock = vi.fn();
vi.mock('@/lib/ec-manager/client', () => ({
  fetchCustomerReturns: (...args: unknown[]) => fetchCustomerReturnsMock(...args),
}));

import { runReturnCommentClassification } from '@/lib/quality/return-comment-classify';
import { fbaReturnKey } from '@/lib/quality/return-reasons';
import type { SupabaseClient } from '@supabase/supabase-js';

const ROW = { orderId: 'o1', sku: 's1', returnDate: '2026-07-01', customerComments: '水が出ない' };
const KEY = fbaReturnKey(ROW);

function makeFakeSb() {
  const rpcCalls: Array<{ name: string; params: unknown }> = [];
  const stateUpdates: string[] = [];
  const symptomUpserts: Array<Record<string, unknown>[]> = [];
  let claimed = false;

  const sb = {
    rpc: (name: string, params: unknown) => {
      rpcCalls.push({ name, params });
      if (name === 'claim_fba_return_classify_batch') {
        if (claimed) return Promise.resolve({ data: [], error: null });
        claimed = true;
        return Promise.resolve({ data: [{ return_key: KEY, attempts: 1 }], error: null });
      }
      if (name === 'top_defect_cause_labels') return Promise.resolve({ data: [], error: null });
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
      if (table === 'fba_return_classify_state') {
        return {
          update: () => ({
            eq: (_col: string, key: string) => {
              stateUpdates.push(key);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === 'fba_return_symptoms') {
        return {
          upsert: (rows: Record<string, unknown>[]) => {
            symptomUpserts.push(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { sb, rpcCalls, stateUpdates, symptomUpserts };
}

const OLD_CLASSIFY_VIA_EMBED = process.env.CLASSIFY_VIA_EMBED;

beforeEach(() => {
  process.env.CLASSIFY_VIA_EMBED = 'true'; // 既定は legacy に変わったため、embed 経路のテストは明示的にONにする
  fetchCustomerReturnsMock.mockReset();
  fetchCustomerReturnsMock.mockResolvedValue({ ok: true, rows: [ROW] });
  runEmbedOneshotAndPollMock.mockReset();
  runEmbedOneshotAndPollMock.mockResolvedValue({
    ok: true,
    result: { symptoms: [{ label: '水が出ない', major_category: 'function_defect' }] },
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

describe('runReturnCommentClassification: embed 経路 (CLASSIFY_VIA_EMBED=true)', () => {
  it('正しい slug/targetType/targetId(=return_key)/input で runEmbedOneshotAndPoll を1本だけ呼ぶ', async () => {
    const { sb, symptomUpserts, stateUpdates } = makeFakeSb();
    const result = await runReturnCommentClassification(sb);

    expect(result.classified).toBe(1);
    expect(invokeChatMock).not.toHaveBeenCalled();
    expect(runEmbedOneshotAndPollMock).toHaveBeenCalledTimes(1);
    const call = runEmbedOneshotAndPollMock.mock.calls[0][0];
    expect(call.slug).toBe('cs:classify-return-comment');
    expect(call.targetType).toBe('fba_return');
    expect(call.targetId).toBe(KEY);
    expect(call.input).toEqual({ comment_masked: '水が出ない', existing_labels: [] });
    expect(symptomUpserts[0]).toEqual([
      { return_key: KEY, cause_label: '水が出ない', major_category: 'function_defect', source: 'ai' },
    ]);
    expect(stateUpdates).toEqual([KEY]);
  });

  it('CLASSIFY_VIA_EMBED=false で invokeChat 直呼び (legacy) へ即時復帰する (embed/legacy 両分岐)', async () => {
    process.env.CLASSIFY_VIA_EMBED = 'false';
    invokeChatMock.mockResolvedValue({
      ok: true,
      structuredOutput: { symptoms: [{ label: '水が出ない', major_category: 'function_defect' }] },
      message: '',
    });
    const { sb } = makeFakeSb();
    const result = await runReturnCommentClassification(sb);

    expect(result.classified).toBe(1);
    expect(runEmbedOneshotAndPollMock).not.toHaveBeenCalled();
    expect(invokeChatMock).toHaveBeenCalledTimes(1);
  });

  it('symptoms:[] (症状なし) は正常成功として classified_at のみ設定する', async () => {
    runEmbedOneshotAndPollMock.mockResolvedValue({ ok: true, result: { symptoms: [] } });
    const { sb, stateUpdates, symptomUpserts } = makeFakeSb();
    const result = await runReturnCommentClassification(sb);

    expect(result.skipped).toBe(1);
    expect(result.classified).toBe(0);
    expect(stateUpdates).toEqual([KEY]);
    expect(symptomUpserts).toHaveLength(0);
  });

  it('embed 失敗 (ok:false) は classified_at を設定しない (attempts はクレーム時加算済のまま。契約不変)', async () => {
    runEmbedOneshotAndPollMock.mockResolvedValue({ ok: false, reason: 'embed_run_poll_deadline' });
    const { sb, stateUpdates, symptomUpserts } = makeFakeSb();
    const result = await runReturnCommentClassification(sb);

    expect(result.failed).toBe(1);
    expect(result.classified).toBe(0);
    expect(stateUpdates).toHaveLength(0);
    expect(symptomUpserts).toHaveLength(0);
  });

  it('embed 応答の形状不正 (symptoms 欠落) は分類失敗 (fail-closed) として扱う', async () => {
    runEmbedOneshotAndPollMock.mockResolvedValue({ ok: true, result: {} });
    const { sb, stateUpdates } = makeFakeSb();
    const result = await runReturnCommentClassification(sb);

    expect(result.failed).toBe(1);
    expect(stateUpdates).toHaveLength(0);
  });
});
