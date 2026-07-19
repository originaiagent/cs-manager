/**
 * runReturnCommentClassification (src/lib/quality/return-comment-classify.ts) の run ループ検証。
 *
 * defect-classify-run.test.ts と同じ理由の回帰防止 (2026-07-19 に defect 側と同じ 1 件ずつ
 * クレーム + 予算ガードへ変更したため):
 *   - まとめて CLASSIFY_BATCH_LIMIT 件を一括クレームすると、その時点で attempts が全件加算され、
 *     run 予算超過で未処理のまま終わった分の retry 予算が空焼きする。
 *   - → クレームは 1 件ずつ (p_limit=1)・attempt の直前に行い、予算超過後は次件をクレームしない。
 *
 * このスイートは AI 呼出経路とは独立なループ挙動を見るため、明示的に legacy 経路
 * (invokeChat 直呼び。既定) へ固定する。embed 経路 (CLASSIFY_VIA_EMBED=true) は
 * return-comment-classify-embed.test.ts。DB / AI / mask / ec-manager は全てモック。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const ROWS = [
  { orderId: 'o1', sku: 's1', returnDate: '2026-07-01', customerComments: '水が出ない' },
  { orderId: 'o2', sku: 's2', returnDate: '2026-07-02', customerComments: '割れていた' },
  { orderId: 'o3', sku: 's3', returnDate: '2026-07-03', customerComments: '歪んでいる' },
];
const KEYS = ROWS.map((r) => fbaReturnKey(r));

interface FakeOpts {
  /** claim RPC が実際にクレーム可能とみなす return_key の集合 (順序どおり 1 件ずつ払い出す)。 */
  claimable: string[];
  claimError?: { message: string } | null;
}

function makeFakeSb(opts: FakeOpts) {
  const rpcCalls: Array<{ name: string; params: unknown }> = [];
  const stateUpdates: string[] = [];
  const symptomUpserts: Array<Record<string, unknown>[]> = [];
  const remaining = [...opts.claimable];

  const sb = {
    rpc: (name: string, params: unknown) => {
      rpcCalls.push({ name, params });
      if (name === 'claim_fba_return_classify_batch') {
        if (opts.claimError) return Promise.resolve({ data: null, error: opts.claimError });
        const limit = (params as { p_limit?: number }).p_limit ?? 1;
        const claimed = remaining.splice(0, limit);
        return Promise.resolve({ data: claimed.map((k) => ({ return_key: k, attempts: 1 })), error: null });
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
  process.env.CLASSIFY_VIA_EMBED = 'false';
  fetchCustomerReturnsMock.mockReset();
  fetchCustomerReturnsMock.mockResolvedValue({ ok: true, rows: ROWS });
  invokeChatMock.mockReset();
  invokeChatMock.mockResolvedValue({
    ok: true,
    structuredOutput: { symptoms: [{ label: '水が出ない', major_category: 'function_defect' }] },
    message: '',
  });
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

describe('runReturnCommentClassification: 1件ずつクレーム (defect-classify.ts と同じ構造への是正)', () => {
  it('claim_fba_return_classify_batch を p_limit=1 で呼ぶ', async () => {
    const { sb, rpcCalls } = makeFakeSb({ claimable: [KEYS[0]] });
    await runReturnCommentClassification(sb);

    const claim = rpcCalls.find((c) => c.name === 'claim_fba_return_classify_batch');
    expect(claim).toBeDefined();
    expect(claim?.params).toMatchObject({ p_keys: KEYS, p_limit: 1, p_max_attempts: 3, p_lease_minutes: 15 });
  });

  it('複数対象を1件ずつクレームして全件処理する', async () => {
    const { sb, rpcCalls } = makeFakeSb({ claimable: [...KEYS] });
    const result = await runReturnCommentClassification(sb);

    expect(result.scanned).toBe(3);
    expect(result.classified).toBe(3);
    // 3件 + 空振り1件 (もう無い) で終了
    expect(rpcCalls.filter((c) => c.name === 'claim_fba_return_classify_batch')).toHaveLength(4);
  });

  it('クレーム対象が0件ならAIを呼ばない', async () => {
    const { sb } = makeFakeSb({ claimable: [] });
    const result = await runReturnCommentClassification(sb);

    expect(result).toEqual({ scanned: 0, classified: 0, skipped: 0, failed: 0, stoppedByBudget: false });
    expect(invokeChatMock).not.toHaveBeenCalled();
  });

  it('ec-managerの返品コメントが0件ならcandidateKeys空でRPCもAIも呼ばない', async () => {
    fetchCustomerReturnsMock.mockResolvedValue({ ok: true, rows: [] });
    const { sb, rpcCalls } = makeFakeSb({ claimable: [] });
    const result = await runReturnCommentClassification(sb);

    expect(result.scanned).toBe(0);
    expect(rpcCalls).toHaveLength(0);
    expect(invokeChatMock).not.toHaveBeenCalled();
  });

  it('クレームRPC失敗はrun失敗としてthrowする', async () => {
    const { sb } = makeFakeSb({ claimable: [], claimError: { message: 'deadlock' } });
    await expect(runReturnCommentClassification(sb)).rejects.toThrow(/claim_fba_return_classify_batch/);
  });
});

describe('runReturnCommentClassification: retry 予算 (attempts) の空焼き防止', () => {
  it('鍵解決 (run 共通セットアップ) 失敗時は1件もクレームしない', async () => {
    resolveRagInternalKeyMock.mockRejectedValue(new Error('CORE_API_URL is not set'));
    const { sb, rpcCalls } = makeFakeSb({ claimable: [...KEYS] });

    await expect(runReturnCommentClassification(sb)).rejects.toThrow(/CORE_API_URL/);
    expect(rpcCalls.some((c) => c.name === 'claim_fba_return_classify_batch')).toBe(false);
    expect(invokeChatMock).not.toHaveBeenCalled();
  });

  it('時間予算を超えたら残りをクレームせず打ち切る (未クレーム = attempts 未消費)', async () => {
    const { sb, rpcCalls } = makeFakeSb({ claimable: [...KEYS] });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    invokeChatMock.mockImplementation(async () => {
      now += 300_000; // 既定予算 240s を1件目で超過させる
      return { ok: true, structuredOutput: { symptoms: [] }, message: '' };
    });

    const result = await runReturnCommentClassification(sb);

    expect(result.scanned).toBe(1);
    expect(result.stoppedByBudget).toBe(true);
    // 2・3件目はクレームすらしない (= attempts を焼かず次runがそのまま拾える)
    expect(rpcCalls.filter((c) => c.name === 'claim_fba_return_classify_batch')).toHaveLength(1);
  });
});

describe('runReturnCommentClassification: 分類失敗時の attempts 契約', () => {
  it('mask/AI呼び出し失敗はclassified_atを立てない (attemptsはクレーム時加算済のまま)', async () => {
    invokeChatMock.mockResolvedValue({ ok: false, error: 'ai down', message: '' });
    const { sb, stateUpdates, symptomUpserts } = makeFakeSb({ claimable: [KEYS[0]] });
    const result = await runReturnCommentClassification(sb);

    expect(result.failed).toBe(1);
    expect(result.classified).toBe(0);
    expect(stateUpdates).toHaveLength(0);
    expect(symptomUpserts).toHaveLength(0);
  });

  it('symptoms:[] (症状なし) は成功扱いでclassified_atのみ設定する', async () => {
    invokeChatMock.mockResolvedValue({ ok: true, structuredOutput: { symptoms: [] }, message: '' });
    const { sb, stateUpdates, symptomUpserts } = makeFakeSb({ claimable: [KEYS[0]] });
    const result = await runReturnCommentClassification(sb);

    expect(result.skipped).toBe(1);
    expect(result.classified).toBe(0);
    expect(stateUpdates).toEqual([KEYS[0]]);
    expect(symptomUpserts).toHaveLength(0);
  });
});
