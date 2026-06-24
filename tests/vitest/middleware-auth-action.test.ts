/**
 * 認証 middleware の Server Action 取り扱い回帰テスト。
 *
 * 不具合 (本テストが守る): セッション切れ時、middleware が **Server Action POST** を
 * `NextResponse.redirect('/login')` で弾くと、Next.js が action 応答を redirect 先へ forward
 * しようとして edge で失敗し ("failed to forward action response: fetch failed")、ブラウザの
 * action Promise が永久未解決 → UI 無限ローディングになっていた。
 *
 * 修正: Server Action リクエスト (POST かつ `next-action` ヘッダ) の認証失敗は redirect せず
 * 401 / 403 を返す。通常のページ遷移 (GET 等) は従来どおり /login へ redirect する。
 *
 * 本テストは「server action は redirect されず 401/403 になる」「通常遷移は redirect のまま」を
 * pin する。修正前なら server action ケースも redirect (3xx) になり fail する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- 依存をモック (edge 検証ロジックは別テスト責務。ここは分岐挙動のみ) ---
vi.mock('@/lib/auth/core-auth-config', () => ({
  isCoreAuthEnabled: () => true,
  TOOL_KEY: 'cs-manager',
}));

const verifyMock = vi.fn();
vi.mock('@/lib/auth/core-oidc-edge', () => ({
  // cookie 値をそのまま token として扱う (token 有無の制御を単純化)。
  extractAccessToken: (v: string | undefined) => v ?? null,
  sessionCookieName: () => 'cs_session',
  verifyCoreAccessToken: (...args: unknown[]) => verifyMock(...args),
}));

// middleware.ts はリポジトリ root (alias @ は ./src のみ指すため相対 import)。
import { middleware } from '../../middleware';

type ReqOpts = { action?: boolean; cookie?: string };

function makeReq(method: string, opts: ReqOpts = {}): NextRequest {
  const headers = new Headers();
  if (opts.action) headers.set('next-action', 'deadbeef');
  const req = new NextRequest(new URL('https://app.test/tickets/123'), {
    method,
    headers,
  });
  if (opts.cookie) req.cookies.set('cs_session', opts.cookie);
  return req;
}

function isRedirect(res: Response): boolean {
  return res.status >= 300 && res.status < 400 && res.headers.get('location') !== null;
}

beforeEach(() => {
  verifyMock.mockReset();
});

describe('middleware: Server Action は redirect ではなく 401/403 で弾く', () => {
  it('token 無し + 通常 GET → /login へ redirect (従来挙動を維持)', async () => {
    const res = await middleware(makeReq('GET'));
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('token 無し + Server Action POST → 401 (redirect しない = 無限ハング防止)', async () => {
    const res = await middleware(makeReq('POST', { action: true }));
    expect(res.status).toBe(401);
    expect(isRedirect(res)).toBe(false);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('無効/期限切れ token + Server Action POST → 401 かつ cookie 削除', async () => {
    verifyMock.mockRejectedValueOnce(new Error('expired'));
    const res = await middleware(makeReq('POST', { action: true, cookie: 'bad-token' }));
    expect(res.status).toBe(401);
    expect(isRedirect(res)).toBe(false);
    // cookie 失効 (maxAge=0) の Set-Cookie が付く。
    expect(res.headers.get('set-cookie') ?? '').toMatch(/cs_session=/);
  });

  it('無効/期限切れ token + 通常 GET → /login へ redirect (従来挙動)', async () => {
    verifyMock.mockRejectedValueOnce(new Error('expired'));
    const res = await middleware(makeReq('GET', { cookie: 'bad-token' }));
    expect(isRedirect(res)).toBe(true);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('有効 token だが tool_access 無し + Server Action POST → 403 (認可不足は 401 と区別)', async () => {
    verifyMock.mockResolvedValueOnce({ toolAccess: { 'cs-manager': false } });
    const res = await middleware(makeReq('POST', { action: true, cookie: 'ok-token' }));
    expect(res.status).toBe(403);
    expect(isRedirect(res)).toBe(false);
  });

  it('有効 token + tool_access 有り + Server Action POST → 素通し (next、非 redirect/非エラー)', async () => {
    verifyMock.mockResolvedValueOnce({ toolAccess: { 'cs-manager': true } });
    const res = await middleware(makeReq('POST', { action: true, cookie: 'ok-token' }));
    expect(res.status).toBe(200);
    expect(isRedirect(res)).toBe(false);
  });
});
