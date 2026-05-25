/**
 * POST /api/auth/logout — セッション cookie を破棄して /login へ。
 *
 * フラグ OFF → 404。ローカル cookie を失効するだけ (Core 側 session には触れない)。
 * 自分の cookie を消すだけなので tool_access ゲートは掛けない。
 */
import { type NextRequest, NextResponse } from 'next/server';
import { isCoreAuthEnabled } from '@/lib/auth/core-auth-config';
import { appIsSecure } from '@/lib/auth/core-oidc-node';
import { sessionCookieName } from '@/lib/auth/core-oidc-edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isCoreAuthEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  const res = NextResponse.redirect(url, { status: 302 });
  res.headers.set('Cache-Control', 'private, no-store');
  const expire = { path: '/', maxAge: 0, secure: appIsSecure(), sameSite: 'lax' as const };
  res.cookies.set(sessionCookieName(), '', { ...expire, httpOnly: true });
  res.cookies.set('csrf_token', '', { ...expire, httpOnly: false });
  res.cookies.set('pkce_verifier', '', { ...expire, httpOnly: true });
  res.cookies.set('oauth_state', '', { ...expire, httpOnly: true });
  return res;
}
