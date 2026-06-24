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

/**
 * Server Action の POST リクエストか判定する。
 *
 * Server Action (client から呼ぶ import/onClick 型) は現在ページ経路への POST として飛び、
 * Next.js が `Next-Action` ヘッダを付与する (Next 14.2.x: server-action-request-meta.js)。
 * この種のリクエストを middleware が `NextResponse.redirect` で弾くと、Next.js が action 応答を
 * redirect 先へ forward しようとして edge で失敗し ("failed to forward action response:
 * fetch failed")、ブラウザ側の action Promise が永久に未解決 → UI 無限ローディングになる。
 * → Server Action だけは redirect せず素の 401/403 を返す (下記 actionAuthResponse)。
 *
 * 注意: 将来 `<form action={serverAction}>` 型 (urlencoded/multipart) を使う場合、本判定では
 * 取りこぼし得るため Next 本体の判定ロジックに寄せる必要がある (現状は onClick/import 型のみ)。
 */
function isServerActionRequest(req: NextRequest): boolean {
  return req.method === 'POST' && req.headers.has('next-action');
}

/**
 * Server Action 認証失敗時の応答。redirect は forward 不能で無限ハングを招くため使わない。
 * body / header に token / PII を一切載せない。client は 401/403 (もしくは戻り値なし) を
 * 認証切れとして扱い、ローディング解除 + 再ログイン誘導で復帰する。
 */
function actionAuthResponse(status: number, opts?: { clearCookie?: boolean }): NextResponse {
  const res = new NextResponse(null, { status });
  res.headers.set('Cache-Control', 'no-store');
  if (opts?.clearCookie) {
    res.cookies.set(sessionCookieName(), '', { path: '/', maxAge: 0 });
  }
  return res;
}

export async function middleware(req: NextRequest) {
  if (!isCoreAuthEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const isAction = isServerActionRequest(req);

  const token = extractAccessToken(req.cookies.get(sessionCookieName())?.value);

  if (!token) {
    if (isAction) return actionAuthResponse(401);
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
    if (isAction) return actionAuthResponse(401, { clearCookie: true });
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('redirect', pathname + req.nextUrl.search);
    const res = NextResponse.redirect(url);
    res.cookies.set(sessionCookieName(), '', { path: '/', maxAge: 0 });
    return res;
  }

  if (user.toolAccess?.[TOOL_KEY] !== true) {
    // 認可不足は認証切れとは別 (403)。再ログインでは解決しないため redirect も error=forbidden。
    if (isAction) return actionAuthResponse(403);
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
