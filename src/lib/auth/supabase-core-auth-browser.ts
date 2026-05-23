'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * origin-core 側 Supabase Auth クライアント（ブラウザ用）
 *
 * 役割:
 *   - getSession / onAuthStateChange 等のクライアント側認証参照
 *   - ユーザー情報のマスタは origin-core にあり、JWT 発行も origin-core が担う
 *
 * Cookie 名は `sb-<core-project-ref>-auth-token` (origin-core プロジェクト ref ベース) となるため、
 * cs-manager 側の Cookie とは衝突しない。
 *
 * ※ cs-manager 自身の Supabase へのブラウザ直アクセスは現状存在しないため、
 *   cs-manager データ用のブラウザクライアントは意図的に追加しない (攻撃面最小化)。
 */
export function getCoreAuthBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_CORE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_CORE_SUPABASE_ANON_KEY!,
  );
}
