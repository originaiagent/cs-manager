/**
 * reply-adapter 方式A の PII 境界テスト (codex blocker 対応)。
 *
 * 検証:
 *  - 顧客名/注文番号 (表記揺れ variant 込み) が customer-reply-writer 送信前にマスクされる
 *  - rag-pii-mask が raw を取り逃しても、送信直前 assertion で残存を検知し fail-closed
 *  - 復元は外部呼び出し後にローカルで行われ、最終 draft に raw が戻る
 *  - upstream error body は echo されない
 *
 * origin-ai fetch (rag-pii-mask / customer-reply-writer) と Core credential はモック。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.ORIGIN_AI_URL = 'https://origin-ai.example.com';

vi.mock('@/lib/credentials', () => ({
  getCredential: vi.fn(async () => ({ credentials: { api_key: 'rag-internal-key' } })),
}));

// 社内枠 grounding 候補取得が叩く cs DB (knowledge_articles) をモック。
// 方式1: rag-hybrid-search のヒット article_id を published/未削除でフィルタしメタを返す。
const articleStore: Record<
  string,
  { id: string; title: string; question: string; answer: string; status: string; deleted_at: string | null }
> = {
  'art-1': {
    id: 'art-1',
    title: '配送日数について',
    question: '配送はどれくらいかかりますか',
    answer: '通常2-3営業日です',
    status: 'published',
    deleted_at: null,
  },
};
vi.mock('@/lib/db/supabase-admin', () => ({
  getSupabaseAdmin: vi.fn(async () => ({
    from: (_t: string) => ({
      select: (_c: string) => ({
        in: (_col: string, ids: string[]) => ({
          eq: (_statusCol: string, status: string) => ({
            is: (_delCol: string, _v: null) => {
              const data = ids
                .map((id) => articleStore[id])
                .filter((r) => r && r.status === status && r.deleted_at === null);
              return Promise.resolve({ data, error: null });
            },
          }),
        }),
      }),
    }),
  })),
}));

const { generateRagReply } = await import('@/lib/rag/reply-adapter');

// サブ用の偽 SupabaseClient (方式A では未使用)
const fakeSb = {} as any;

interface StubOpts {
  /** rag-pii-mask が返す masked_text を制御。未指定なら入力をそのまま返す (= NER 取りこぼし再現)。 */
  maskTransform?: (text: string) => string;
  agentDraft?: string;
}

let agentBodies: string[] = [];

function installFetchStub(opts: StubOpts = {}) {
  const orig = global.fetch;
  global.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (u.endsWith('/api/skills/rag-pii-mask')) {
      const texts: string[] = body.texts ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: texts.map((t) => ({
            masked_text: opts.maskTransform ? opts.maskTransform(t) : t,
            replacements: [],
            mask_failed: false,
          })),
        }),
      } as any;
    }
    if (u.endsWith('/api/skills/rag-hybrid-search')) {
      // 社内枠 grounding 候補の再検索 (方式1)。art-1 のみヒットさせる。
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { chunk_id: 'c1', article_id: 'art-1', article_version: 1, content: '配送…' },
          ],
        }),
      } as any;
    }
    if (u.endsWith('/api/agents/customer-reply-writer/chat')) {
      agentBodies.push(typeof body.message === 'string' ? body.message : '');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          agent: 'customer-reply-writer',
          // 既定はセンチネル封筒 (split-reply で parseOk=true になる形)。
          // 顧客向け本文に placeholder を含め、ローカル復元で raw が戻ることを検証する。
          text:
            opts.agentDraft ??
            [
              '<<<ORIGIN_CS_CUSTOMER_REPLY_V1>>>',
              'こんにちは {{customer_name}} 様。ご注文 {{order_id}} について…',
              '<<<END_ORIGIN_CS_CUSTOMER_REPLY_V1>>>',
            ].join('\n'),
          model: 'mock',
        }),
      } as any;
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as any;
  return () => {
    global.fetch = orig;
  };
}

let restore: (() => void) | null = null;
beforeEach(() => {
  agentBodies = [];
});
afterEach(() => {
  if (restore) restore();
  restore = null;
  vi.restoreAllMocks();
});

describe('reply-adapter PII boundary (方式A)', () => {
  it('顧客名/注文番号は agent 送信メッセージに raw で含まれない (variant 込み)', async () => {
    // rag-pii-mask は名前/注文番号を取り逃す (素通し) と仮定
    restore = installFetchStub();
    const result = await generateRagReply(fakeSb, {
      subject: '配送について',
      inquiryBody: '山田太郎です。注文 123-456-7890 はいつ届きますか',
      customerName: '山田太郎',
      orderNumber: '123-456-7890',
      category: '配送',
      channelId: null,
      tenantId: null,
    });
    expect(result.ok).toBe(true);
    expect(agentBodies).toHaveLength(1);
    const sent = agentBodies[0];
    // raw 値 (および主要 variant) が送信メッセージに残っていない
    expect(sent).not.toContain('山田太郎');
    expect(sent).not.toContain('123-456-7890');
    expect(sent).not.toContain('1234567890');
    // placeholder に置換されている
    expect(sent).toContain('{{customer_name}}');
    expect(sent).toContain('{{order_id}}');
    // 構造分離成功 (センチネル封筒) → parseOk=true, draft=顧客向け本文のみ
    expect(result.parseOk).toBe(true);
    // 復元はローカル: 最終 draft (= 顧客向け本文) には raw が戻る
    expect(result.draft).toContain('山田太郎');
    expect(result.draft).toContain('123-456-7890');
    // 方式A: citation は空・searchHitCount=0 (shape 互換)
    expect(result.citations).toEqual([]);
    expect(result.searchHitCount).toBe(0);
    // 社内枠: parseOk=true → 方式1 再検索で関連ナレッジ候補 (実メタ) が付く
    expect(result.groundingArticles).toHaveLength(1);
    expect(result.groundingArticles?.[0].id).toBe('art-1');
    expect(result.groundingArticles?.[0].title).toBe('配送日数について');
    expect(result.groundingArticles?.[0].question).toBe('配送はどれくらいかかりますか');
    expect(result.groundingArticles?.[0].answer).toBe('通常2-3営業日です');
    // 表示専用フィールドは draft (送信本文) に絶対入らない
    expect(result.draft).not.toContain('配送日数について');
    expect(result.draft).not.toContain('通常2-3営業日です');
  });

  it('parseOk=false (fail-closed) では grounding 候補を取得しない (再検索を呼ばない)', async () => {
    let hybridCalled = false;
    const orig = global.fetch;
    global.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(init.body) : {};
      if (u.endsWith('/api/skills/rag-pii-mask')) {
        const texts: string[] = body.texts ?? [];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            results: texts.map((t) => ({ masked_text: t, replacements: [], mask_failed: false })),
          }),
        } as any;
      }
      if (u.endsWith('/api/skills/rag-hybrid-search')) {
        hybridCalled = true;
        return { ok: true, status: 200, json: async () => ({ results: [] }) } as any;
      }
      if (u.endsWith('/api/agents/customer-reply-writer/chat')) {
        // センチネル無し → split-reply が fail-closed
        return {
          ok: true,
          status: 200,
          json: async () => ({ text: 'マーカー無しの素の本文', model: 'mock' }),
        } as any;
      }
      throw new Error(`unexpected ${u}`);
    }) as any;
    restore = () => {
      global.fetch = orig;
    };
    const result = await generateRagReply(fakeSb, {
      subject: '配送',
      inquiryBody: 'いつ届きますか',
      customerName: null,
      orderNumber: null,
      category: null,
    });
    expect(result.ok).toBe(true);
    expect(result.parseOk).toBe(false);
    // fail-closed では grounding 再検索を行わない (rag-hybrid-search 未呼出)
    expect(hybridCalled).toBe(false);
    expect(result.groundingArticles).toEqual([]);
  });

  it('センチネル無しの agent 出力 → parseOk=false, draft 空 (fail-closed), 社内テキストは draft に入らない', async () => {
    // agent がセンチネルを付けず raw を返す (混在の可能性) → split-reply が fail-closed
    restore = installFetchStub({
      agentDraft: 'こんにちは {{customer_name}} 様。\n根拠: 社内記事#1\n📋 担当者メモ',
    });
    const result = await generateRagReply(fakeSb, {
      subject: '配送',
      inquiryBody: '山田太郎です。注文 123-456-7890',
      customerName: '山田太郎',
      orderNumber: '123-456-7890',
      category: '配送',
    });
    expect(result.ok).toBe(true);
    // fail-closed: draft は空、社内テキスト/raw は draft に絶対入らない
    expect(result.parseOk).toBe(false);
    expect(result.draft).toBe('');
    // 社内テキストはオペレータ用 internalPreview にのみ載る (raw 全文、PII 復元済)
    expect(result.internalPreview).toContain('根拠');
    expect(result.internalPreview).toContain('担当者メモ');
  });

  it('表記揺れ (空白入り顧客名) も variant でマスクされる', async () => {
    restore = installFetchStub();
    const result = await generateRagReply(fakeSb, {
      subject: null,
      inquiryBody: '山田 太郎 様 が問い合わせ',
      customerName: '山田太郎',
      orderNumber: null,
      category: null,
    });
    expect(result.ok).toBe(true);
    const sent = agentBodies[0];
    expect(sent).not.toContain('山田 太郎');
    expect(sent).not.toContain('山田太郎');
  });

  it('mask_failed=true は agent を呼ばず fail-closed', async () => {
    const orig = global.fetch;
    global.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/api/skills/rag-pii-mask')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ masked_text: '', replacements: [], mask_failed: true }] }),
        } as any;
      }
      if (u.endsWith('/api/agents/customer-reply-writer/chat')) {
        agentBodies.push('SHOULD_NOT_BE_CALLED');
        return { ok: true, status: 200, json: async () => ({ text: 'x' }) } as any;
      }
      throw new Error('unexpected');
    }) as any;
    restore = () => {
      global.fetch = orig;
    };
    const result = await generateRagReply(fakeSb, {
      subject: null,
      inquiryBody: '山田太郎です',
      customerName: '山田太郎',
      orderNumber: null,
      category: null,
    });
    expect(result.ok).toBe(false);
    expect(result.maskFailed).toBe(true);
    expect(agentBodies).toHaveLength(0);
  });

  it('upstream error body は echo されない (PII 非露出)', async () => {
    const orig = global.fetch;
    global.fetch = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/api/skills/rag-pii-mask')) {
        return {
          ok: false,
          status: 400,
          text: async () => '山田太郎 invalid input echo', // raw を含む偽 echo
          json: async () => ({}),
        } as any;
      }
      throw new Error('should not reach');
    }) as any;
    restore = () => {
      global.fetch = orig;
    };
    const result = await generateRagReply(fakeSb, {
      subject: null,
      inquiryBody: '山田太郎です',
      customerName: '山田太郎',
      orderNumber: null,
      category: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('rag-pii-mask 400');
    expect(result.error).not.toContain('山田太郎');
  });
});
