'use server';

import { redirect } from 'next/navigation';
import { getCoreAuthServerClient } from '@/lib/auth/supabase-core-auth-server';
import {
  hasRole,
  isCoreAuthEnabled,
  isCoreAuthConfigured,
  REQUIRED_ROLE,
  sanitizeRedirectPath,
} from '@/lib/auth/core-auth-config';

/**
 * ログイン処理
 *
 * origin-core 側 Supabase Auth に対して signInWithPassword を実行する。
 * ユーザーアカウントは origin-core にしか存在しないため、
 * cs-manager 側 Supabase で signIn してはいけない (Third-Party Auth 設計)。
 */
export async function signInAction(formData: FormData): Promise<void> {
  if (!formData || typeof (formData as unknown as FormData).get !== 'function') {
    redirect(
      '/login?error=' +
        encodeURIComponent('リクエスト形式が不正です。再度お試しください。'),
    );
  }

  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const redirectTo = sanitizeRedirectPath(String(formData.get('redirect') ?? '/'));

  // フラグ OFF / Core env 未設定では Core クライアントを生成せず穏当に戻す
  // (createServerClient(undefined!,...) の throw を回避し、現行挙動を保つ)。
  if (!isCoreAuthEnabled() || !isCoreAuthConfigured()) {
    redirectToLoginWithError(redirectTo, 'ユーザーログインは現在無効です。');
  }

  if (!email || !password) {
    redirectToLoginWithError(redirectTo, 'メールアドレスとパスワードを入力してください');
  }

  const auth = getCoreAuthServerClient();
  const { data, error } = await auth.auth.signInWithPassword({ email, password });

  if (error) {
    redirectToLoginWithError(redirectTo, error.message);
  }

  // cs-manager 用ロールを持たないアカウントはログインさせない
  // (signIn で発行された session は cookie に残らないよう signOut)。
  if (!hasRole(data?.user?.app_metadata, REQUIRED_ROLE)) {
    await auth.auth.signOut();
    redirectToLoginWithError(redirectTo, 'このアカウントには cs-manager へのアクセス権がありません');
  }

  redirect(redirectTo || '/');
}

export async function signOutAction(): Promise<void> {
  const auth = getCoreAuthServerClient();
  await auth.auth.signOut();
  redirect('/login');
}

function redirectToLoginWithError(redirectTo: string, message: string): never {
  const params = new URLSearchParams();
  if (redirectTo) params.set('redirect', redirectTo);
  params.set('error', message);
  redirect(`/login?${params.toString()}`);
}
