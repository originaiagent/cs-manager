/**
 * /api/tickets/[id]/drafts 安全ゲート 契約テスト (API ルート単位)。
 *
 * 構造保証の出口の 1 つ (POST/GET) を pin する:
 *  - POST: ai_draft/rag は is_separated=true 必須 (なし → 400)
 *  - POST: is_separated=true でも body に内部マーカーがあれば 400 (parser 迂回防止)
 *  - POST: ai_draft + is_separated=true + クリーン body → 201 相当 (ok:true, 保存される)
 *  - GET : 最新が ai_draft/rag かつ is_separated=false (旧形式) → body='' + legacyUnsafe
 *  - GET : manual → そのまま返す (legacyUnsafe なし)
 *
 * auth と supabase-admin はモック (DB 非依存)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 認可は常に通す (ゲートロジックそのものを検証するため)
vi.mock('@/lib/auth/api-auth', () => ({
  authorizeApiRoute: () => null,
}));

// supabase-admin フェイク: insert は受領 row をそのまま返す。GET は注入した latestDraft を返す。
let latestDraft: Record<string, unknown> | null = null;
let lastInsert: Record<string, unknown> | null = null;

vi.mock('@/lib/db/supabase-admin', () => ({
  getSupabaseAdmin: async () => ({
    from(table: string) {
      if (table === 'tickets') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { id: 't1' }, error: null }) }),
          }),
        };
      }
      if (table === 'ticket_drafts') {
        return {
          // GET chain
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: latestDraft, error: null }),
                  }),
                }),
              }),
            }),
          }),
          // POST chain
          insert: (row: Record<string, unknown>) => {
            lastInsert = row;
            return {
              select: () => ({
                single: async () => ({ data: { id: 'd1', ...row }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { POST, GET } = await import('../../app/api/tickets/[id]/drafts/route');

function makeReq(body: unknown): any {
  return { json: async () => body } as any;
}
const params = { params: { id: 't1' } };

beforeEach(() => {
  latestDraft = null;
  lastInsert = null;
});

describe('POST /drafts 安全ゲート', () => {
  it('ai_draft + is_separated なし → 400', async () => {
    const res = await POST(makeReq({ body: '顧客向け本文', source: 'ai_draft' }), params);
    expect(res.status).toBe(400);
    expect(lastInsert).toBeNull();
  });

  it('rag + is_separated なし → 400', async () => {
    const res = await POST(makeReq({ body: '本文', source: 'rag' }), params);
    expect(res.status).toBe(400);
    expect(lastInsert).toBeNull();
  });

  it('ai_draft + is_separated=true でも内部マーカー入り body → 400 (parser 迂回防止)', async () => {
    const res = await POST(
      makeReq({ body: '顧客向け本文\n\n社内用: 管理画面で確認', source: 'ai_draft', is_separated: true }),
      params,
    );
    expect(res.status).toBe(400);
    expect(lastInsert).toBeNull();
  });

  it('ai_draft + is_separated=true + クリーン body → ok:true で保存 (is_separated=true)', async () => {
    const res = await POST(
      makeReq({ body: 'お問い合わせありがとうございます。承りました。', source: 'ai_draft', is_separated: true }),
      params,
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(lastInsert).toMatchObject({ source: 'ai_draft', is_separated: true });
  });

  it('manual は is_separated なしでも保存可 (既定 false)', async () => {
    const res = await POST(makeReq({ body: '手動返信', source: 'manual' }), params);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(lastInsert).toMatchObject({ source: 'manual', is_separated: false });
  });

  it('first_response は汎用 POST allowlist 外 → 400 (orchestrator 専用)', async () => {
    const res = await POST(makeReq({ body: 'テンプレ', source: 'first_response' }), params);
    expect(res.status).toBe(400);
    expect(lastInsert).toBeNull();
  });
});

describe('GET /drafts redaction', () => {
  it('旧 ai_draft (is_separated=false) → body 空 + legacyUnsafe', async () => {
    latestDraft = { id: 'd1', body: '混在の可能性 body', source: 'ai_draft', is_separated: false };
    const res = await GET(makeReq({}), params);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.draft.body).toBe('');
    expect(j.draft.legacyUnsafe).toBe(true);
  });

  it('旧 rag (is_separated=false) → body 空 + legacyUnsafe', async () => {
    latestDraft = { id: 'd1', body: '混在 body', source: 'rag', is_separated: false };
    const res = await GET(makeReq({}), params);
    const j = await res.json();
    expect(j.draft.body).toBe('');
    expect(j.draft.legacyUnsafe).toBe(true);
  });

  it('分離済み ai_draft (is_separated=true) → body そのまま', async () => {
    latestDraft = { id: 'd1', body: '顧客向け本文', source: 'ai_draft', is_separated: true };
    const res = await GET(makeReq({}), params);
    const j = await res.json();
    expect(j.draft.body).toBe('顧客向け本文');
    expect(j.draft.legacyUnsafe).toBeUndefined();
  });

  it('manual → body そのまま (legacyUnsafe なし)', async () => {
    latestDraft = { id: 'd1', body: '手動返信', source: 'manual', is_separated: false };
    const res = await GET(makeReq({}), params);
    const j = await res.json();
    expect(j.draft.body).toBe('手動返信');
    expect(j.draft.legacyUnsafe).toBeUndefined();
  });
});
