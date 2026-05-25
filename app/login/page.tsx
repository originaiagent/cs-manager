import {
  isCoreAuthEnabled,
  isCoreAuthConfigured,
  sanitizeRedirectPath,
} from '@/lib/auth/core-auth-config';

export const dynamic = 'force-dynamic';

/**
 * ログイン画面 (OIDC リダイレクト方式)。
 *
 * - フラグ OFF / Core 未設定 → ログイン無効の案内のみ (現行挙動維持)。
 * - フラグ ON → 「origin-core でログイン」ボタンを表示。クリックで /api/auth/login へ遷移し、
 *   origin-core の認可画面にリダイレクトされる。
 *
 * ループ防止: 自動リダイレクトはしない (ボタン明示)。error=forbidden 時もボタンは出すが
 * 自動再ログインはしない (権限なしアカウントの無限ループ回避)。
 */
export default function LoginPage({
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
          <p className="text-sm text-gray-500">ユーザーログインは現在無効です。</p>
        </div>
      </div>
    );
  }

  const loginHref = `/api/auth/login?redirect=${encodeURIComponent(redirectTo)}`;
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

        <a
          href={loginHref}
          className="block w-full rounded-md bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white transition hover:bg-gray-800"
        >
          origin-core でログイン
        </a>
      </div>
    </div>
  );
}
