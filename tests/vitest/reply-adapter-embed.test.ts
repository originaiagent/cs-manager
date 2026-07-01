/**
 * reply-adapter (origin-ai embed 一本化版) のテスト。
 *
 * 検証:
 *  - origin-ai embed `cs-reply:draft` を **1 本だけ** 起動し正しい引数で呼ぶ
 *  - 結果 (reply_draft / needs_escalation / escalation_reason / sources) を顧客/社内に分離して写す
 *  - 送信安全ゲート (isCustomerSafeBody, **実関数**) で fail-closed:
 *      空 reply_draft / 内部マーカー混入 → draft='' / parseOk=false
 *  - sources の knowledge source (article_id 持ち) のみ cs DB 実メタへ解決し社内枠表示
 *    (lookup source は除外、draft/送信 path 非流入)
 *  - ticketId 欠落 / embed 失敗は ok=false + PII-safe ラベル (raw 非露出)
 *
 * embed helper (runEmbedOneshotAndPoll) はモック。split-reply (isCustomerSafeBody) は実関数。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/embed/run-oneshot', () => ({
  runEmbedOneshotAndPoll: vi.fn(),
}));

import { runEmbedOneshotAndPoll } from '@/lib/embed/run-oneshot';
import { generateRagReply } from '@/lib/rag/reply-adapter';

const mockRun = runEmbedOneshotAndPoll as unknown as ReturnType<typeof vi.fn>;

// cs DB knowledge_articles の表示メタ (社内枠 grounding 候補)。full UUID で /knowledge/<id> リンク。
const ARTICLE_UUID = '11111111-2222-4333-8444-555555555555';
const articleStore: Record<
  string,
  { id: string; title: string; question: string; answer: string; status: string; deleted_at: string | null }
> = {
  [ARTICLE_UUID]: {
    id: ARTICLE_UUID,
    title: '配送日数について',
    question: '配送はどれくらいかかりますか',
    answer: '通常2-3営業日です',
    status: 'published',
    deleted_at: null,
  },
};

// fetchGroundingMeta が叩く cs DB チェーン (.from.select.in.eq.is → Promise<{data,error}>) を模倣。
const fakeSb = {
  from: (_t: string) => ({
    select: (_c: string) => ({
      in: (_col: string, ids: string[]) => ({
        eq: (_c2: string, status: string) => ({
          is: (_c3: string, _v: null) =>
            Promise.resolve({
              data: ids
                .map((id) => articleStore[id])
                .filter((r) => r && r.status === status && r.deleted_at === null),
              error: null,
            }),
        }),
      }),
    }),
  }),
} as any;

const baseInput = {
  subject: '配送について',
  inquiryBody: 'いつ届きますか',
  customerName: '山田太郎',
  category: '配送',
  channelId: null,
  tenantId: null,
  ticketId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  productId: 'prod-123',
};

const SAFE_DRAFT =
  '山田太郎様\n\nお問い合わせありがとうございます。ご注文は通常2-3営業日でお届けしております。\n\n何卒よろしくお願いいたします。';

beforeEach(() => {
  mockRun.mockReset();
});

describe('reply-adapter (embed 一本化)', () => {
  it('正常: embed を cs-reply:draft で1本起動し、reply_draft/sources を顧客/社内に分離して写す', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: {
        reply_draft: SAFE_DRAFT,
        needs_escalation: false,
        sources: [
          {
            kind: 'cs_knowledge',
            ref: 'ナレッジ(cs, article=...)',
            chunk_id: 'c1',
            article_id: ARTICLE_UUID,
            article_version: 1,
            score: 0.83,
            excerpt: '配送は通常…',
          },
        ],
      },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    // embed は ちょうど 1 回、正しい引数で。
    expect(mockRun).toHaveBeenCalledTimes(1);
    const callArg = mockRun.mock.calls[0][0];
    expect(callArg.slug).toBe('cs-reply:draft');
    expect(callArg.targetType).toBe('customer_record');
    expect(callArg.targetId).toBe(baseInput.ticketId);
    expect(callArg.input.inquiry_text).toContain('いつ届きますか');
    expect(callArg.input.inquiry_text).toContain('配送について'); // subject 連結
    expect(callArg.input.customer_name).toBe('山田太郎');
    expect(callArg.input.product_id).toBe('prod-123');

    // 結果写像
    expect(result.ok).toBe(true);
    expect(result.parseOk).toBe(true);
    expect(result.draft).toBe(SAFE_DRAFT);
    expect(result.needsHuman).toBe(false);
    expect(result.searchHitCount).toBe(1);

    // citations: knowledge source のみ
    expect(result.citations).toHaveLength(1);
    expect(result.citations?.[0].article_id).toBe(ARTICLE_UUID);
    expect(result.citations?.[0].rrf_score).toBe(0.83);
    // Bug2a 根治: citation の title が cs DB 実メタから解決される (従来 title:null ハードコード)。
    expect(result.citations?.[0].title).toBe('配送日数について');
    // 非エスカレーション正常系。
    expect(result.escalated).toBe(false);

    // 社内枠 grounding: cs DB 実メタ解決 (full UUID / 表示専用)
    expect(result.groundingArticles).toHaveLength(1);
    expect(result.groundingArticles?.[0].id).toBe(ARTICLE_UUID);
    expect(result.groundingArticles?.[0].title).toBe('配送日数について');

    // 表示専用メタは draft (送信本文) に絶対入らない
    expect(result.draft).not.toContain('配送日数について');
    expect(result.draft).not.toContain('通常2-3営業日です');
  });

  it('fail-closed: 本物のリークマーカー (INTERNAL_/センチネル) 混入の reply_draft は parseOk=false / draft 空 / internalPreview に全文', async () => {
    // 現契約では reply_draft は顧客専用フィールド。本物のリーク信号 (INTERNAL_ / ORIGIN_CS
    // センチネル) が混入した場合のみ送信安全ゲートが fail-closed する。
    const LEAKY = `${SAFE_DRAFT}\nINTERNAL_NOTE: 在庫確認\n<<<ORIGIN_CS_INTERNAL_NOTES_V1>>>`;
    mockRun.mockResolvedValue({
      ok: true,
      result: { reply_draft: LEAKY, needs_escalation: false, sources: [] },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(true);
    expect(result.parseOk).toBe(false);
    expect(result.draft).toBe('');
    // 社内テキストはオペレータ用 internalPreview にのみ載る (全文)
    expect(result.internalPreview).toContain('INTERNAL_NOTE');
  });

  it('Bug1 根治: 内容記述語 (根拠/検索結果) を含む正当な顧客返信は parseOk=true (false-positive 解消)', async () => {
    // 支払い問い合わせ等で「ご請求の根拠」を含む正当な顧客返信が空化されていた false-positive クラス。
    // 内容記述語では弾かない (社内向けラベルは引き続き遮断)。
    const OK_DRAFT = `${SAFE_DRAFT}\nご請求の根拠となる明細と検索結果をあわせてご案内いたします。`;
    mockRun.mockResolvedValue({
      ok: true,
      result: { reply_draft: OK_DRAFT, needs_escalation: false, sources: [] },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(true);
    expect(result.parseOk).toBe(true);
    expect(result.draft).toBe(OK_DRAFT);
    expect(result.escalated).toBe(false);
  });

  it('fail-closed: reply_draft 空は parseOk=false / draft 空', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: { reply_draft: '', needs_escalation: false, sources: [] },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(true);
    expect(result.parseOk).toBe(false);
    expect(result.draft).toBe('');
    // 空だが非エスカレーション(稀): escalated=false で「回答不能」とは区別される。
    expect(result.escalated).toBe(false);
  });

  it('needs_escalation=true → needsHuman=true / internalNotesText=escalation_reason', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: {
        reply_draft: SAFE_DRAFT,
        needs_escalation: true,
        escalation_reason: '在庫状況の確認が必要です',
        sources: [],
      },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(true);
    // P1-a (codex code review): エスカレーションは自動採用不可 → reply_draft が安全でも parseOk=false / draft空。
    expect(result.parseOk).toBe(false);
    expect(result.draft).toBe('');
    expect(result.needsHuman).toBe(true);
    // Bug1 根治: エスカレーションは第一級フラグとして UI へ渡る。
    expect(result.escalated).toBe(true);
    expect(result.internalNotesText).toBe('在庫状況の確認が必要です');
  });

  it('Bug1: 空 reply_draft + needs_escalation=true (fabef855 実データ型) → escalated=true / parseOk=false / draft空 / 理由あり', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: {
        reply_draft: '',
        needs_escalation: true,
        escalation_reason:
          'コンビニ決済の支払い手順テンプレートがナレッジに存在しないため。',
        sources: [],
      },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(true);
    // 空なので送信安全ゲートは通らない(parseOk=false)…
    expect(result.parseOk).toBe(false);
    expect(result.draft).toBe('');
    // …が、これは「分離失敗」ではなく「エスカレーション(回答不能)」だと区別できる。
    expect(result.escalated).toBe(true);
    expect(result.needsHuman).toBe(true);
    expect(result.internalNotesText).toBe(
      'コンビニ決済の支払い手順テンプレートがナレッジに存在しないため。',
    );
  });

  it('lookup source (article_id 無し) は grounding/citations に含めない', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: {
        reply_draft: SAFE_DRAFT,
        needs_escalation: false,
        sources: [{ kind: 'lookup', ref: 'product_status_lookup' }],
      },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.groundingArticles).toEqual([]);
    expect(result.searchHitCount).toBe(1); // sources 件数自体は反映
  });

  it('ticketId 欠落は embed を呼ばず ok=false (no_target_ticket)', async () => {
    const { ticketId: _omit, ...noTicket } = baseInput;
    const result = await generateRagReply(fakeSb, noTicket);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_target_ticket');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('契約破壊 (reply_draft 欠落/型違い) は ok=false / embed_result_invalid_shape (正常応答に丸めない)', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: { needs_escalation: false, sources: [] }, // reply_draft 欠落
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('embed_result_invalid_shape');
  });

  it('契約破壊 (needs_escalation 非boolean) も ok=false / embed_result_invalid_shape', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: { reply_draft: SAFE_DRAFT, needs_escalation: 'no', sources: [] },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('embed_result_invalid_shape');
  });

  it('malformed sources (null / 非object 要素) でも throw せず安全に処理', async () => {
    mockRun.mockResolvedValue({
      ok: true,
      result: {
        reply_draft: SAFE_DRAFT,
        needs_escalation: false,
        sources: [null, 'x', 123, { kind: 'cs_knowledge', article_id: ARTICLE_UUID, score: 0.5 }],
      },
    });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(true);
    expect(result.parseOk).toBe(true);
    // 有効 object source のみ反映 (null/'x'/123 は除外)
    expect(result.searchHitCount).toBe(1);
    expect(result.citations).toHaveLength(1);
    expect(result.groundingArticles).toHaveLength(1);
  });

  it('embed 失敗は ok=false + PII-safe ラベル (raw 非露出)', async () => {
    mockRun.mockResolvedValue({ ok: false, reason: 'embed_run_poll_deadline' });

    const result = await generateRagReply(fakeSb, baseInput);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('embed_run_poll_deadline');
    // raw (顧客名/本文) を error に出さない
    expect(result.error).not.toContain('山田太郎');
    expect(result.error).not.toContain('いつ届きますか');
  });
});
