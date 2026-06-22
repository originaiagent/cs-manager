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
    if (u.endsWith('/api/agents/customer-reply-writer/chat')) {
      agentBodies.push(typeof body.message === 'string' ? body.message : '');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          agent: 'customer-reply-writer',
          text: opts.agentDraft ?? 'こんにちは {{customer_name}} 様。ご注文 {{order_id}} について…',
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
    // 復元はローカル: 最終 draft には raw が戻る
    expect(result.draft).toContain('山田太郎');
    expect(result.draft).toContain('123-456-7890');
    // 方式A: citation は空・searchHitCount=0 (shape 互換)
    expect(result.citations).toEqual([]);
    expect(result.searchHitCount).toBe(0);
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
