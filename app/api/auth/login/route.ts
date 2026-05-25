/**
 * GET /api/auth/login — OIDC 認可開始 (origin-core へリダイレクト)。
 *
 * フラグ OFF → 404 (現行挙動維持)。
 * フラグ ON → OAuth client を実行時取得 → PKCE verifier + state を短命 HttpOnly cookie に保存
 *            → Core authorize エンドポイントへ 302。
 *
 * client_id / issuer_url は Core credential から実行時取得 (env 非配置)。
 * redirect_uri は getRedirectUri() の固定値のみ (request 由来禁止)。
 */
import { type NextRequest, NextResponse } from 'next/server';
import { isCoreAuthEnabled, sanitizeRedirectPath } from '@/lib/auth/core-auth-config';
import {
  getOriginAIOAuth,
  deriveOAuthEndpoints,
  getRedirectUri,
  generatePkce,
  generateState,
  appIsSecure,
  CredentialFetchError,
} from '@/lib/auth/core-oidc-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!isCoreAuthEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const redirectPath = sanitizeRedirectPath(req.nextUrl.searchParams.get('redirect'));

  let issuerUrl: string;
  let clientId: string;
  try {
    ({ issuerUrl, clientId } = await getOriginAIOAuth());
  } catch (err) {
    console.error(
      '[auth/login] credential fetch failed:',
      err instanceof CredentialFetchError ? `${err.serviceCode} status=${err.status ?? 'null'}` : 'error',
    );
    return NextResponse.json({ error: 'Auth temporarily unavailable' }, { status: 502 });
  }

  const { authorizeUrl } = deriveOAuthEndpoints(issuerUrl);
  const { verifier, challenge } = generatePkce();
  const state = generateState(redirectPath);

  const target = new URL(authorizeUrl);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', clientId);
  target.searchParams.set('redirect_uri', getRedirectUri());
  target.searchParams.set('code_challenge', challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  target.searchParams.set('state', state);

  const res = NextResponse.redirect(target.toString(), { status: 302 });
  res.headers.set('Cache-Control', 'private, no-store');
  const cookieOpts = {
    httpOnly: true,
    secure: appIsSecure(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 600,
  };
  res.cookies.set('pkce_verifier', verifier, cookieOpts);
  res.cookies.set('oauth_state', state, cookieOpts);
  return res;
}
