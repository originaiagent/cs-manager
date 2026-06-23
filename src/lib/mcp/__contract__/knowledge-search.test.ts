/**
 * MCP `knowledge_search` read tool contract — security-critical (方式A / codex 方式I)。
 *
 * 検証する不変条件:
 *   §A 専用静的キー (CS_MCP_KNOWLEDGE_TOKEN) → knowledge_search が動く
 *   §B その静的キー → list / read / write には到達できない (METHOD_NOT_FOUND / 認可されない)
 *   §C run-scoped JWT 風トークン → knowledge_search は拒否 (静的キー専用)
 *   §D mask_failed → hybrid-search を呼ばない (検索中止)
 *   §E tool args の db_target / pii_state / filter_visibility は無視 (サーバ固定)
 *   §F limit は ≤8 に clamp される
 *   §G tools/list に knowledge_search が匿名で見える / inputSchema 妥当
 *
 * origin-ai fetch (rag-pii-mask / rag-hybrid-search) と Core credential / Supabase はモック。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- env (route / knowledge-search が参照) -----------------------------------
const KNOWLEDGE_TOKEN = 'cs-knowledge-secret-token';
process.env.CS_MCP_KNOWLEDGE_TOKEN = KNOWLEDGE_TOKEN;
process.env.ORIGIN_AI_URL = 'https://origin-ai.example.com';
process.env.MCP_SERVER_NAME = 'cs-manager';
process.env.ORIGIN_AI_BASE_URL = 'https://origin-ai.example.com';
// rag internal key は Core credential モックで供給する (getCredential)。

// --- Core credential モック (rag internal key) -------------------------------
vi.mock('@/lib/credentials', () => ({
  getCredential: vi.fn(async (serviceCode: string) => {
    if (serviceCode === 'origin_ai_internal') {
      return { credentials: { api_key: 'rag-internal-key' } };
    }
    // cs_mcp_knowledge は env 優先のため通常到達しないが、念のため返す。
    if (serviceCode === 'cs_mcp_knowledge') {
      return { credentials: { token: KNOWLEDGE_TOKEN } };
    }
    return { credentials: {} };
  }),
}));

// --- Supabase admin モック (knowledge_articles published title 解決) ----------
const articleStore: Record<
  string,
  { id: string; title: string; status: string; deleted_at: string | null }
> = {
  'art-1': { id: 'art-1', title: '配送についてのFAQ', status: 'published', deleted_at: null },
  'art-2': { id: 'art-2', title: '下書き記事', status: 'draft', deleted_at: null },
  // published だが soft delete 済み → 検索結果から除外されること
  'art-3': {
    id: 'art-3',
    title: '削除済み記事',
    status: 'published',
    deleted_at: '2026-01-01T00:00:00Z',
  },
};
vi.mock('@/lib/db/supabase-admin', () => ({
  getSupabaseAdmin: vi.fn(async () => ({
    from: (_table: string) => ({
      select: (_cols: string) => ({
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

// 動的 import (mock 適用後)
const { POST } = await import('../../../../app/api/mcp/route');

// --- fetch stub (origin-ai rag skills) ---------------------------------------
let hybridSearchCalls: Array<Record<string, unknown>> = [];
let maskCalls: Array<{ texts: string[] }> = [];

interface StubOpts {
  maskFailed?: boolean;
  hits?: Array<{ chunk_id: string; article_id: string; article_version: number; content: string }>;
}

function installFetchStub(opts: StubOpts = {}) {
  const orig = global.fetch;
  global.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};

    if (u.endsWith('/api/skills/rag-pii-mask')) {
      maskCalls.push(body);
      const texts: string[] = body.texts ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: texts.map((t: string) => ({
            masked_text: opts.maskFailed ? '' : t,
            replacements: [],
            mask_failed: !!opts.maskFailed,
          })),
        }),
      } as any;
    }

    if (u.endsWith('/api/skills/rag-hybrid-search')) {
      hybridSearchCalls.push(body);
      const hits =
        opts.hits ?? [
          { chunk_id: 'c1', article_id: 'art-1', article_version: 1, content: '配送は2-3日です' },
          { chunk_id: 'c2', article_id: 'art-2', article_version: 1, content: '下書き本文' },
        ];
      return { ok: true, status: 200, json: async () => ({ results: hits }) } as any;
    }

    throw new Error(`unexpected fetch: ${u}`);
  }) as any;
  return () => {
    global.fetch = orig;
  };
}

let restoreFetch: (() => void) | null = null;

function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
  return new Request('https://cs.example.com/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeEach(() => {
  hybridSearchCalls = [];
  maskCalls = [];
});
afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// §G tools/list
// ---------------------------------------------------------------------------

describe('§G tools/list', () => {
  it('knowledge_search が匿名 tools/list に含まれ inputSchema が妥当', async () => {
    const res = await POST(rpc('tools/list') as any);
    const j = await res.json();
    const tool = j.result.tools.find((t: any) => t.name === 'knowledge_search');
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['query']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties.limit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §A 正規の静的キー → knowledge_search が動く
// ---------------------------------------------------------------------------

describe('§A 静的キーで knowledge_search が動作', () => {
  it('正しい CS_MCP_KNOWLEDGE_TOKEN で published のみ masked 結果を返す', async () => {
    restoreFetch = installFetchStub();
    const res = await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: '配送日数' } }, bearer(KNOWLEDGE_TOKEN)) as any,
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    const payload = JSON.parse(j.result.content[0].text);
    // art-2 は draft のため除外され、art-1 のみ
    expect(payload.count).toBe(1);
    expect(payload.results[0].article_id).toBe('art-1');
    expect(payload.results).toHaveLength(1);
    // chunk/title が返る
    expect(payload.results[0].chunk_id).toBe('c1');
    expect(payload.results[0]).toHaveProperty('title');
  });

  it('soft delete (deleted_at) 済みの published 記事は除外される', async () => {
    restoreFetch = installFetchStub({
      hits: [
        { chunk_id: 'c1', article_id: 'art-1', article_version: 1, content: '配送は2-3日です' },
        { chunk_id: 'c3', article_id: 'art-3', article_version: 1, content: '削除済み本文' },
      ],
    });
    const res = await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: '配送' } }, bearer(KNOWLEDGE_TOKEN)) as any,
    );
    const j = await res.json();
    const payload = JSON.parse(j.result.content[0].text);
    // art-3 は deleted_at 非 null のため除外され art-1 のみ
    expect(payload.count).toBe(1);
    expect(payload.results[0].article_id).toBe('art-1');
  });

  it('認証なしは 401', async () => {
    restoreFetch = installFetchStub();
    const res = await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: 'x' } }) as any,
    );
    const j = await res.json();
    expect(j.error.code).toBe(-32001);
    expect(j.error.message).toContain('認証');
  });

  it('誤った静的キーは 401 (hybrid-search を呼ばない)', async () => {
    restoreFetch = installFetchStub();
    const res = await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: 'x' } }, bearer('wrong-token')) as any,
    );
    const j = await res.json();
    expect(j.error.code).toBe(-32001);
    expect(hybridSearchCalls).toHaveLength(0);
    expect(maskCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §B 静的キーは list / read / write に到達できない
// ---------------------------------------------------------------------------

describe('§B 静的キー ⇏ list/read/write', () => {
  it('静的キーで list を叩いても knowledge_search 扱いにならず JWT 認証経路で拒否される', async () => {
    restoreFetch = installFetchStub();
    const res = await POST(
      rpc('tools/call', { name: 'list', arguments: { form_id: 'customer_record' } }, bearer(KNOWLEDGE_TOKEN)) as any,
    );
    const j = await res.json();
    // 静的キーは JWT として無効 → 認証エラー (knowledge_search 扱いにはならない)
    expect(j.error).toBeDefined();
    expect(j.error.code).toBe(-32001);
    // 検索 API は一切呼ばれない (静的キー分岐は list に進入しない)
    expect(hybridSearchCalls).toHaveLength(0);
  });

  it('静的キーで write を叩いても knowledge_search 扱いにならず拒否される', async () => {
    restoreFetch = installFetchStub();
    const res = await POST(
      rpc(
        'tools/call',
        {
          name: 'write',
          arguments: {
            form_id: 'customer_record',
            ops: [{ kind: 'set', place_id: 'memo', value: 'x' }],
            dry_run: true,
            idempotency_key: 'k',
            provenance: { source: 's', run_id: 'r' },
          },
        },
        bearer(KNOWLEDGE_TOKEN),
      ) as any,
    );
    const j = await res.json();
    expect(j.error).toBeDefined();
    expect(j.error.code).toBe(-32001);
  });
});

// ---------------------------------------------------------------------------
// §C run-scoped JWT 風トークン → knowledge_search は拒否
// ---------------------------------------------------------------------------

describe('§C JWT ⇏ knowledge_search', () => {
  it('JWT 形式のトークンでは knowledge_search は 401 (静的キー専用)', async () => {
    restoreFetch = installFetchStub();
    // 3 セグメントの JWT 風文字列 (静的キーと不一致)
    const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJydW5faWQiOiJyLTEifQ.sig';
    const res = await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: 'x' } }, bearer(fakeJwt)) as any,
    );
    const j = await res.json();
    expect(j.error.code).toBe(-32001);
    expect(hybridSearchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §D mask_failed → hybrid-search を呼ばない
// ---------------------------------------------------------------------------

describe('§D mask_failed fail-closed', () => {
  it('query の mask_failed 時は hybrid-search を呼ばず tool error', async () => {
    restoreFetch = installFetchStub({ maskFailed: true });
    const res = await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: '田中太郎の注文' } }, bearer(KNOWLEDGE_TOKEN)) as any,
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    // tool-level error 封筒
    expect(j.result.isError).toBe(true);
    const payload = JSON.parse(j.result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('マスク');
    expect(hybridSearchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §E サーバ固定パラメータは tool args で上書きできない
// ---------------------------------------------------------------------------

describe('§E server-fixed params', () => {
  it('tool args の db_target/pii_state/filter_visibility は無視される', async () => {
    restoreFetch = installFetchStub();
    await POST(
      rpc(
        'tools/call',
        {
          name: 'knowledge_search',
          arguments: {
            query: '返品',
            db_target: 'core',
            pii_state: 'raw',
            filter_visibility: ['confidential'],
            require_acl: false,
            status: 'draft',
          },
        },
        bearer(KNOWLEDGE_TOKEN),
      ) as any,
    );
    expect(hybridSearchCalls).toHaveLength(1);
    const call = hybridSearchCalls[0];
    expect(call.db_target).toBe('cs');
    expect(call.pii_state).toBe('masked');
    expect(call.filter_visibility).toEqual(['public', 'internal']);
  });
});

// ---------------------------------------------------------------------------
// §F limit clamp
// ---------------------------------------------------------------------------

describe('§F limit clamp ≤8', () => {
  it('limit=100 は 8 に clamp されて hybrid-search へ渡る', async () => {
    restoreFetch = installFetchStub();
    await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: 'x', limit: 100 } }, bearer(KNOWLEDGE_TOKEN)) as any,
    );
    expect(hybridSearchCalls[0].limit).toBe(8);
  });

  it('limit=0 は 1 に clamp される', async () => {
    restoreFetch = installFetchStub();
    await POST(
      rpc('tools/call', { name: 'knowledge_search', arguments: { query: 'x', limit: 0 } }, bearer(KNOWLEDGE_TOKEN)) as any,
    );
    expect(hybridSearchCalls[0].limit).toBe(1);
  });
});
