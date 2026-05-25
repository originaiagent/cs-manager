import { NextResponse, type NextRequest } from 'next/server';
import { isCoreAuthEnabled, TOOL_KEY } from '@/lib/auth/core-auth-config';
import {
  verifyCoreAccessToken,
  extractAccessToken,
  sessionCookieName,
} from '@/lib/auth/core-oidc-edge';

/**
 * ユーザー認証ゲート (Core を IdP とする OIDC リダイレクト方式)。
 *
 * フラグ OFF (既定): 何もせず素通し = 現行 (ユーザーログイン無し) の挙動を完全維持。
 *
 * フラグ ON:
 *   1. session cookie (callback が発行した base64-json) から access_token を抽出
 *   2. JWKS で検証 (iss / aud='authenticated' / client_id / sig) — Core への往復なし
 *   3. 未ログイン / 検証失敗 → /login?redirect=<元パス> (無効 cookie は削除)
 *   4. ログイン済だが tool_access['cs-manager'] 無し → /login?error=forbidden
 *
 * 例外パス (USER ゲート対象外):
 *   - /login : 認証画面 (ループ防止のため自動リダイレクトしないボタン式)
 *   - /api/* : 全 API ルート。各ルートが独自 tier 認可 (internal-key / cron / diag) を持つため
 *              USER ゲートは触れない。/api/auth/* もここに含まれる (login/callback は自前で flag 判定)。
 *   - /_next 等 : matcher で除外
 *
 * Edge 安全: core-oidc-edge.ts (jose + Web API のみ) だけを import する。
 */
const PUBLIC_PATHS = ['/login', '/api'];

export async function middleware(req: NextRequest) {
  if (!isCoreAuthEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const token = extractAccessToken(req.cookies.get(sessionCookieName())?.value);

  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('redirect', pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  let user;
  try {
    user = await verifyCoreAccessToken(token);
  } catch {
    // 無効・期限切れトークン: cookie を削除しつつ再ログインへ。
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('redirect', pathname + req.nextUrl.search);
    const res = NextResponse.redirect(url);
    res.cookies.set(sessionCookieName(), '', { path: '/', maxAge: 0 });
    return res;
  }

  if (user.toolAccess?.[TOOL_KEY] !== true) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('error', 'forbidden');
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
