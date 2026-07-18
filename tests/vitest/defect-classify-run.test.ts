/**
 * runDefectClassification (src/lib/quality/defect-classify.ts) の run ループ検証。
 *
 * 本番実データで判明した 2 欠陥の回帰防止:
 *   欠陥1 二重分類: 対象取得は原子的クレーム RPC (claim_defect_classify_batch) 経由であり、
 *     tickets の素の select を使わないこと。attempts はクレーム時に加算済のため、
 *     失敗経路で classify_attempts を再更新しない (二重加算防止)。
 *   欠陥2 小分け防止不発: product_id が null のチケット (実データの 9 割超) でも
 *     グローバル頻出ラベルがプロンプトに提示されること。
 *
 * 加えて「retry 予算 (classify_attempts) の空焼き」回帰防止:
 *   attempts++ はクレーム時に確定コミットされるため、AI に投げていないチケットに
 *   課してはならない (3 run 分焼けると attempts>=3 で恒久的に分類対象外)。
 *   → セットアップはクレーム前 / クレームは 1 件ずつ attempt 直前 / 予算超過は未クレームで残す。
 *
 * DB / AI / mask は全てモック (glue 挙動のみ検証。外部送信・PII は扱わない)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeChatMock = vi.fn();
vi.mock('@/lib/ai-client', () => ({
  invokeChat: (...args: unknown[]) => invokeChatMock(...args),
}));

// mask は素通し (本テストは PII 経路ではなく glue を見る)
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

interface FakeOpts {
  claimed: Array<{
    id: string;
    subject: string | null;
    product_id: string | null;
    classify_attempts: number;
  }>;
  globalLabels?: Array<{ label: string; n: number }>;
  globalLabelsError?: { message: string } | null;
  claimError?: { message: string } | null;
  inboundBody?: string | null;
}

/** rpc / from チェーンを備えた最小の fake Supabase client + 監視用 spy */
function makeFakeSb(opts: FakeOpts) {
  const rpcCalls: Array<{ name: string; params: unknown }> = [];
  const ticketUpdates: Array<Record<string, unknown>> = [];
  const tableReads: string[] = [];
  // 実 RPC を模す: クレームした行は lease が打たれ以降の述語から外れる = キューから消費する。
  // (毎回同じ行を返す fake だと 1 件ずつクレームの前進が検証できない)
  const claimQueue = [...opts.claimed];

  const sb = {
    rpc: (name: string, params: unknown) => {
      rpcCalls.push({ name, params });
      if (name === 'claim_defect_classify_batch') {
        if (opts.claimError) return Promise.resolve({ data: null, error: opts.claimError });
        const limit = (params as { p_limit?: number }).p_limit ?? 1;
        return Promise.resolve({ data: claimQueue.splice(0, limit), error: null });
      }
      if (name === 'top_defect_cause_labels') {
        return Promise.resolve({
          data: opts.globalLabelsError ? null : (opts.globalLabels ?? []),
          error: opts.globalLabelsError ?? null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    },
    from: (table: string) => {
      tableReads.push(table);
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
                      Promise.resolve({
                        data:
                          opts.inboundBody === null
                            ? null
                            : { body: opts.inboundBody ?? 'water leaks from the unit' },
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'ticket_defect_causes') {
        return {
          // product スコープ照合 (product_id 保有時のみ到達)
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

  return { sb, rpcCalls, ticketUpdates, tableReads };
}

const TICKET = {
  id: '1e4d461c-0000-4000-8000-000000000001',
  subject: 'ミラーの件',
  product_id: null,
  classify_attempts: 1,
};

// このテストスイートはクレーム RPC / 予算ガードのループ挙動 (AI 呼出経路とは独立) を見るため、
// 明示的に legacy 経路 (invokeChat 直呼び) へ固定する。embed 経路 (既定) のテストは
// defect-classify-embed.test.ts に分離した。
const OLD_CLASSIFY_VIA_EMBED = process.env.CLASSIFY_VIA_EMBED;

beforeEach(() => {
  process.env.CLASSIFY_VIA_EMBED = 'false';
  invokeChatMock.mockReset();
  invokeChatMock.mockResolvedValue({
    ok: true,
    structuredOutput: {
      category: 'defect',
      causes: [{ label: 'ミラー表面に傷あり', major_category: 'damaged' }],
    },
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
  vi.restoreAllMocks(); // Date.now spy 等を戻す
});

describe('runDefectClassification: 対象取得は原子的クレーム RPC (欠陥1)', () => {
  it('claim_defect_classify_batch を lease/上限つき・1 件ずつ呼ぶ', async () => {
    const { sb, rpcCalls } = makeFakeSb({ claimed: [TICKET] });
    await runDefectClassification(sb);

    const claim = rpcCalls.find((c) => c.name === 'claim_defect_classify_batch');
    expect(claim).toBeDefined();
    // p_limit=1: バッチ先取りすると AI に渡していないチケットの attempts が焼ける
    expect(claim?.params).toEqual({
      p_limit: 1,
      p_max_attempts: 3,
      p_lease_minutes: 15,
    });
  });

  it('成功時の tickets 更新に classify_attempts を含めない (クレーム時加算済 = 二重加算防止)', async () => {
    const { sb, ticketUpdates } = makeFakeSb({ claimed: [TICKET] });
    const result = await runDefectClassification(sb);

    expect(result.classified).toBe(1);
    expect(ticketUpdates).toHaveLength(1);
    expect(ticketUpdates[0]).not.toHaveProperty('classify_attempts');
    expect(ticketUpdates[0]).toMatchObject({ case_category: 'defect', defect_type: 'damaged' });
  });

  it('分類失敗時に classify_attempts を再更新しない (二重加算防止)', async () => {
    invokeChatMock.mockResolvedValue({ ok: false, error: 'ai down', message: '' });
    const { sb, ticketUpdates } = makeFakeSb({ claimed: [TICKET] });
    const result = await runDefectClassification(sb);

    expect(result.failed).toBe(1);
    expect(result.classified).toBe(0);
    expect(ticketUpdates).toHaveLength(0);
  });

  it('inbound 無しスキップ時も classify_attempts を再更新しない', async () => {
    const { sb, ticketUpdates } = makeFakeSb({
      claimed: [{ ...TICKET, subject: null }],
      inboundBody: '',
    });
    const result = await runDefectClassification(sb);

    expect(result.skippedNoInbound).toBe(1);
    expect(ticketUpdates).toHaveLength(0);
    expect(invokeChatMock).not.toHaveBeenCalled();
  });

  it('クレーム対象が 0 件なら AI を呼ばない', async () => {
    const { sb } = makeFakeSb({ claimed: [] });
    const result = await runDefectClassification(sb);

    expect(result).toEqual({
      scanned: 0,
      classified: 0,
      failed: 0,
      skippedNoInbound: 0,
      stoppedByBudget: false,
    });
    expect(invokeChatMock).not.toHaveBeenCalled();
  });

  it('クレーム RPC 失敗は run 失敗として throw する (対象取得不能)', async () => {
    const { sb } = makeFakeSb({ claimed: [], claimError: { message: 'deadlock' } });
    await expect(runDefectClassification(sb)).rejects.toThrow(/claim_defect_classify_batch/);
  });

  it('複数対象を 1 件ずつクレームして全件処理する', async () => {
    const { sb, rpcCalls } = makeFakeSb({
      claimed: [TICKET, { ...TICKET, id: '1e4d461c-0000-4000-8000-000000000002' }],
    });
    const result = await runDefectClassification(sb);

    expect(result.scanned).toBe(2);
    expect(result.classified).toBe(2);
    // 対象 2 件 + 空振り 1 件 (= もう無い) を確認して終了
    expect(rpcCalls.filter((c) => c.name === 'claim_defect_classify_batch')).toHaveLength(3);
  });
});

describe('runDefectClassification: retry 予算 (classify_attempts) の空焼き防止', () => {
  it('鍵解決 (run 共通セットアップ) 失敗時は 1 件もクレームしない', async () => {
    // Core 不達 / CORE_CREDENTIAL_KEY 未設定を模す。クレーム後に置くと、AI に一度も
    // 渡していないチケットの attempts が焼け、3 run で恒久的に分類対象外になる。
    resolveRagInternalKeyMock.mockRejectedValue(new Error('CORE_API_URL is not set'));
    const { sb, rpcCalls } = makeFakeSb({ claimed: [TICKET] });

    await expect(runDefectClassification(sb)).rejects.toThrow(/CORE_API_URL/);
    expect(rpcCalls.some((c) => c.name === 'claim_defect_classify_batch')).toBe(false);
    expect(invokeChatMock).not.toHaveBeenCalled();
  });

  it('時間予算を超えたら残りをクレームせず打ち切る (未クレーム = attempts 未消費)', async () => {
    const { sb, rpcCalls } = makeFakeSb({
      claimed: [
        TICKET,
        { ...TICKET, id: '1e4d461c-0000-4000-8000-000000000002' },
        { ...TICKET, id: '1e4d461c-0000-4000-8000-000000000003' },
      ],
    });
    // 仮想時計: 1 件処理するたびに 300s 進める (既定予算 240s を 1 件目で超過)
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    invokeChatMock.mockImplementation(async () => {
      now += 300_000;
      return { ok: true, structuredOutput: { category: 'other' }, message: '' };
    });

    const result = await runDefectClassification(sb);

    expect(result.scanned).toBe(1);
    expect(result.classified).toBe(1);
    expect(result.stoppedByBudget).toBe(true);
    // 2・3 件目はクレームすらしない (= attempts を焼かず次 run がそのまま拾える)
    expect(rpcCalls.filter((c) => c.name === 'claim_defect_classify_batch')).toHaveLength(1);
  });
});

describe('runDefectClassification: 既存ラベル提示 (欠陥2)', () => {
  it('product_id が null でもグローバル頻出ラベルをプロンプトに提示する', async () => {
    const { sb } = makeFakeSb({
      claimed: [{ ...TICKET, product_id: null }],
      globalLabels: [{ label: 'ミラー表面に傷がある', n: 5 }, { label: '水が出ない', n: 2 }],
    });
    await runDefectClassification(sb);

    const prompt = invokeChatMock.mock.calls[0][0] as string;
    expect(prompt).toContain('## existing_labels');
    expect(prompt).toContain('- ミラー表面に傷がある');
    expect(prompt).toContain('- 水が出ない');
  });

  it('既存ラベルの一字一句再利用をプロンプトで拘束する', async () => {
    const { sb } = makeFakeSb({
      claimed: [TICKET],
      globalLabels: [{ label: 'ミラー表面に傷がある', n: 5 }],
    });
    await runDefectClassification(sb);

    const prompt = invokeChatMock.mock.calls[0][0] as string;
    expect(prompt).toContain('一字一句そのまま');
    // ハルシネーション防止の既存文言を維持していること
    expect(prompt).toContain('推測・創作は禁止');
  });

  it('語彙 RPC が失敗しても分類は続行する (fail-soft)', async () => {
    const { sb } = makeFakeSb({
      claimed: [TICKET],
      globalLabelsError: { message: 'rpc missing' },
    });
    const result = await runDefectClassification(sb);

    expect(result.classified).toBe(1);
    const prompt = invokeChatMock.mock.calls[0][0] as string;
    expect(prompt).not.toContain('## existing_labels');
  });

  it('product_id 保有時もグローバル語彙 RPC を併用する', async () => {
    const { sb, rpcCalls } = makeFakeSb({
      claimed: [{ ...TICKET, product_id: '101' }],
      globalLabels: [{ label: '水が出ない', n: 2 }],
    });
    await runDefectClassification(sb);

    expect(rpcCalls.some((c) => c.name === 'top_defect_cause_labels')).toBe(true);
    const prompt = invokeChatMock.mock.calls[0][0] as string;
    expect(prompt).toContain('- 水が出ない');
  });
});
