/**
 * /api/diag/ai ルートのテスト (分類2cron embed 移行に伴う discovery 追随)。
 *
 * 検証:
 *  - tier='diag' 認可: X-Diag-Token 無しは 401
 *  - CLASSIFY_VIA_EMBED=true (既定): GET /api/embed/discovery を叩き、
 *    kind='oneshot' の対象2 slug (cs:classify-defect / cs:classify-return-comment) が
 *    両方可視な時のみ ok:true。401/403・slug不足は ok:false (HTTP 200 でも契約破壊を握り潰さない)
 *  - CLASSIFY_VIA_EMBED=false: 現行 invokeChat ping のまま
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const invokeChatMock = vi.fn();
vi.mock('@/lib/ai-client', () => ({
  invokeChat: (...args: unknown[]) => invokeChatMock(...args),
}));

import { GET } from '../../app/api/diag/ai/route';

const OLD_ENV = { ...process.env };

function diagReq() {
  return new NextRequest('http://localhost/api/diag/ai', {
    headers: { 'x-diag-token': 'test-diag-token' },
  });
}

beforeEach(() => {
  process.env.DIAG_TOKEN = 'test-diag-token';
  process.env.EMBED_CLIENT_KEY = 'test-embed-key';
  process.env.ORIGIN_AI_BASE_URL = 'https://origin-ai.example.com';
  invokeChatMock.mockReset();
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe('/api/diag/ai 認可', () => {
  it('X-Diag-Token 無しは 401 (discovery/invokeChat を呼ばない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await GET(new NextRequest('http://localhost/api/diag/ai'));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invokeChatMock).not.toHaveBeenCalled();
  });
});

describe('/api/diag/ai: CLASSIFY_VIA_EMBED=true (既定) discovery 検証', () => {
  it('正常: kind=oneshot の対象2 slug が両方可視なら ok:true', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        works: [
          { kind: 'oneshot', slug: 'cs:classify-defect' },
          { kind: 'oneshot', slug: 'cs:classify-return-comment' },
          { kind: 'oneshot', slug: 'cs-reply:draft' },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(diagReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(invokeChatMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://origin-ai.example.com/api/embed/discovery',
      expect.objectContaining({ headers: { 'X-Embed-Key': 'test-embed-key' } }),
    );
  });

  it('対象slugが不足 (HTTP 200でも) ok:false', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ works: [{ kind: 'oneshot', slug: 'cs:classify-defect' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(diagReq());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('cs:classify-return-comment');
  });

  it('kind!=oneshot (workflow等) は対象カウントしない → slug不足でok:false', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        works: [
          { kind: 'workflow', slug: 'cs:classify-defect' },
          { kind: 'oneshot', slug: 'cs:classify-return-comment' },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(diagReq());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('cs:classify-defect');
  });

  it('discovery 401 (embed鍵未認可) は ok:false', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(diagReq());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('discovery_401');
  });

  it('discovery 403 (embed client 不一致) は ok:false', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(diagReq());
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('discovery_403');
  });
});

describe('/api/diag/ai: CLASSIFY_VIA_EMBED=false は現行 invokeChat ping のまま', () => {
  it('invokeChat の結果をそのまま返す (discovery は呼ばない)', async () => {
    process.env.CLASSIFY_VIA_EMBED = 'false';
    invokeChatMock.mockResolvedValue({ ok: true, message: 'pong', traceId: 't1', durationMs: 5 });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(diagReq());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe('pong');
    expect(invokeChatMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
