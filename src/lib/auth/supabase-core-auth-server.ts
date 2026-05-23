import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * origin-core 側 Supabase Auth クライアント（Server Component / Server Action / Route Handler 用）
 *
 * - ユーザーのマスタは origin-core にあり、JWT 発行も origin-core が担う (Third-Party Auth / JWKS)。
 * - signInWithPassword / signOut / getUser の起点。
 * - Cookie ストアと連携し、middleware で更新された origin-core の session を共有する。
 *
 * ※ middleware では本ヘルパを使わない。middleware は NextRequest/NextResponse の
 *   cookie に直接バインドした createServerClient を自前生成する (edge での session refresh のため)。
 */
export function getCoreAuthServerClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_CORE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_CORE_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component から set すると Next が例外を投げる。middleware で refresh 済の前提。
          }
        },
      },
    },
  );
}
