import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import {
  isCoreAuthEnabled,
  hasRole,
  REQUIRED_ROLE,
} from '@/lib/auth/core-auth-config';

/**
 * ユーザー認証ゲート (Core を IdP とする Third-Party Auth)。
 *
 * フラグ OFF (既定): 何もせず素通し = 現行 (ユーザーログイン無し) の挙動を完全維持。
 *
 * フラグ ON:
 *   1. Cookie の origin-core Supabase セッションを読み込む
 *   2. getUser() で origin-core 発行の JWT を検証
 *   3. 未ログイン → /login?redirect=<元パス> にリダイレクト
 *   4. ログイン済だが REQUIRED_ROLE を持たない → /login?error=forbidden
 *
 * 例外パス (USER ゲート対象外):
 *   - /login        : 認証画面そのもの
 *   - /api/*         : 全 API ルート。各ルートが独自の tier 認可 (internal-key / cron / diag) を
 *                      持つため、USER ゲートは一切触れない。これにより内部 API 呼び出し・
 *                      Vercel Cron (ユーザー session 無し) はフラグ ON/OFF に関わらず動作し続ける。
 *   - /_next/* 等    : matcher で除外
 *
 * 重要: middleware が握る Cookie は origin-core 側 Supabase の session。
 *   cs-manager 側 DB へのアクセスは従来通り service_role (server-side) で行う。
 *   本ゲートはページ到達の認可 (ロール込み) を担う。
 */
const PUBLIC_PATHS = ['/login', '/api'];

export async function middleware(req: NextRequest) {
  // フラグ OFF: 完全素通し (現行挙動)。
  if (!isCoreAuthEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request: { headers: req.headers } });

  const coreAuth = createServerClient(
    process.env.NEXT_PUBLIC_CORE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_CORE_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: req.headers } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await coreAuth.auth.getUser();

  if (!user) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    // 元のパス+クエリを保持 (オープンリダイレクト防止は /login 側で sanitize)。
    loginUrl.searchParams.set('redirect', pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // ログイン済でも cs-manager 用ロールが無ければアクセス不可。
  if (!hasRole(user.app_metadata, REQUIRED_ROLE)) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('error', 'forbidden');
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // 認証必須にしたいパス。Next 内部・静的ファイル・画像は除外。
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
