import { redirect } from 'next/navigation';
import { signInAction } from './actions';
import { getCoreAuthServerClient } from '@/lib/auth/supabase-core-auth-server';
import {
  isCoreAuthEnabled,
  isCoreAuthConfigured,
  hasToolAccess,
  sanitizeRedirectPath,
} from '@/lib/auth/core-auth-config';

export const dynamic = 'force-dynamic';

/**
 * ログイン画面。
 *
 * - フラグ OFF または Core env 未設定 → ログインは無効。フォームを出さず案内のみ表示
 *   (Core 認証クライアントを生成しない = 例外を出さない)。現行 (ログイン無し) 挙動を保つ。
 * - フラグ ON かつ既にログイン済 (かつロール保有) → redirect 先へ即座に遷移 (ループ防止)。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams?: { error?: string; redirect?: string };
}) {
  const error = searchParams?.error;
  const redirectTo = sanitizeRedirectPath(searchParams?.redirect);

  const authReady = isCoreAuthEnabled() && isCoreAuthConfigured();

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="mb-1 text-xl font-semibold text-gray-900">cs-manager</h1>
          <p className="text-sm text-gray-500">
            ユーザーログインは現在無効です。
          </p>
        </div>
      </div>
    );
  }

  {
    const auth = getCoreAuthServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (user && hasToolAccess(user.app_metadata)) {
      redirect(redirectTo);
    }
  }

  const errorMessage =
    error === 'forbidden'
      ? 'このアカウントには cs-manager へのアクセス権がありません'
      : error;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-gray-900">cs-manager</h1>
        <p className="mb-6 text-sm text-gray-500">
          オリジンアカウントでログインしてください
        </p>

        {errorMessage ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </div>
        ) : null}

        <form action={signInAction} className="space-y-4">
          <input type="hidden" name="redirect" value={redirectTo} />
          <div>
            <label
              htmlFor="email"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              メールアドレス
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              パスワード
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800"
          >
            ログイン
          </button>
        </form>
      </div>
    </div>
  );
}
