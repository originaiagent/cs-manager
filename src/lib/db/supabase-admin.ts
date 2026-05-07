import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase service_role クライアント（サーバ専用）
 *
 * - 必ず NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を要求
 * - service_role は RLS をバイパスするため、絶対にクライアントに露出させない
 * - Vercel 環境では関数 invocation ごとに新しいインスタンスを作る方針（接続プール無し）
 */

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

  // Vercel CLI が末尾に \n を含めることがあるため除去
  const url = rawUrl.replace(/\s+$/, '');

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
