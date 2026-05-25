/**
 * GET /api/auth/callback — OIDC code 交換 + セッション確立。
 *
 * フラグ OFF → 404。
 * フラグ ON → state を cookie と照合 → code を token endpoint で交換 (client_secret は実行時取得) →
 *            access_token を JWKS 検証 (iss/aud/client_id) → tool_access ゲート →
 *            最小セッション cookie を発行 → 検証済み相対パスへ 302。
 *
 * - redirect_uri は getRedirectUri() 固定値。Core credential metadata と 3-way 一致を検証 (不一致 503)。
 * - tool_access['cs-manager'] が無いアカウントには **セッション cookie を発行しない** (forbidden へ)。
 * - cookie は最小 {access_token, expires_at} のみ。refresh_token は保存しない (silent refresh 未実装)。
 */
import { type NextRequest, NextResponse } from 'next/server';
import { isCoreAuthEnabled, sanitizeRedirectPath, TOOL_KEY } from '@/lib/auth/core-auth-config';
import {
  getOriginAIOAuth,
  deriveOAuthEndpoints,
  getRedirectUri,
  appIsSecure,
  newCsrfToken,
  parseState,
  resolveSameOriginRedirect,
  CredentialFetchError,
} from '@/lib/auth/core-oidc-node';
import { verifyCoreAccessToken, sessionCookieName } from '@/lib/auth/core-oidc-edge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'oauth_state';
const PKCE_COOKIE = 'pkce_verifier';
const CSRF_COOKIE = 'csrf_token';

function loginRedirect(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url, { status: 302 });
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
}

/** 短命 PKCE / state cookie を即失効。 */
function clearTransientCookies(res: NextResponse): void {
  const base = { path: '/', maxAge: 0, secure: appIsSecure(), httpOnly: true, sameSite: 'lax' as const };
  res.cookies.set(PKCE_COOKIE, '', base);
  res.cookies.set(STATE_COOKIE, '', base);
}

export async function GET(req: NextRequest) {
  if (!isCoreAuthEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const code = req.nextUrl.searchParams.get('code');
  const stateParam = req.nextUrl.searchParams.get('state');
  if (!code || !stateParam) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
  if (stateParam !== stateCookie) {
    return NextResponse.json({ error: 'State mismatch' }, { status: 400 });
  }
  const parsed = parseState(stateParam);
  if (!parsed) {
    return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
  }
  const verifier = req.cookies.get(PKCE_COOKIE)?.value;
  if (!verifier) {
    return NextResponse.json({ error: 'Missing PKCE verifier' }, { status: 400 });
  }
  const redirectPath = sanitizeRedirectPath(parsed.redirect);

  let issuerUrl: string;
  let clientId: string;
  let clientSecret: string;
  let metadataRedirectUri: string | null;
  try {
    ({ issuerUrl, clientId, clientSecret, metadataRedirectUri } = await getOriginAIOAuth());
  } catch (err) {
    console.error(
      '[auth/callback] credential fetch failed:',
      err instanceof CredentialFetchError ? `${err.serviceCode} status=${err.status ?? 'null'}` : 'error',
    );
    return NextResponse.json({ error: 'Auth temporarily unavailable' }, { status: 502 });
  }

  // 3-way redirect_uri 一致 (実行時は APP_BASE_URL 由来 == Core credential metadata のみ照合)。
  const redirectUri = getRedirectUri();
  if (metadataRedirectUri && metadataRedirectUri !== redirectUri) {
    console.error('[auth/callback] redirect_uri mismatch between APP_BASE_URL and Core credential metadata');
    return NextResponse.json({ error: 'Core OAuth misconfigured' }, { status: 503 });
  }

  const { tokenUrl } = deriveOAuthEndpoints(issuerUrl);

  let tokenResp: Response;
  try {
    tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
  } catch (err) {
    console.error('[auth/callback] token exchange network error:', (err as Error)?.message || err);
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 502 });
  }
  if (!tokenResp.ok) {
    console.error('[auth/callback] token endpoint status:', tokenResp.status);
    return NextResponse.json({ error: 'Token exchange rejected' }, { status: 401 });
  }

  const session = (await tokenResp.json()) as {
    access_token?: string;
    expires_at?: number;
    expires_in?: number;
  };
  const accessToken = session.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: 'No access_token in token response' }, { status: 502 });
  }

  // 発行された access_token をサーバ面で検証 (iss/aud/client_id) + 認可ゲート。
  // client_id は Core から実行時取得した authoritative な値で照合 (単一の正 — codex FAIL #2)。
  let user;
  try {
    user = await verifyCoreAccessToken(accessToken, clientId);
  } catch (err) {
    console.error('[auth/callback] access_token verification failed:', (err as Error)?.message || err);
    return NextResponse.json({ error: 'Token verification failed' }, { status: 401 });
  }
  if (user.toolAccess?.[TOOL_KEY] !== true) {
    // 当ツール権限なし: セッション cookie を発行せず forbidden へ。
    const res = loginRedirect(req, { error: 'forbidden' });
    clearTransientCookies(res);
    return res;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = typeof session.expires_at === 'number' ? session.expires_at : nowSec + (session.expires_in ?? 3600);
  const maxAge = Math.max(0, Math.min(expiresAt - nowSec, 3600));

  const sessionValue = 'base64-' + Buffer.from(JSON.stringify({ access_token: accessToken, expires_at: expiresAt })).toString('base64');

  const res = NextResponse.redirect(resolveSameOriginRedirect(redirectPath), { status: 302 });
  res.headers.set('Cache-Control', 'private, no-store');
  const secure = appIsSecure();
  res.cookies.set(sessionCookieName(), sessionValue, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  // double-submit 用の非 HttpOnly csrf_token (将来の状態変更系 API 用)。
  res.cookies.set(CSRF_COOKIE, newCsrfToken(), {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
  clearTransientCookies(res);
  return res;
}
