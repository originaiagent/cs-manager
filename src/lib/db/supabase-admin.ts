import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCredential } from '@/lib/credentials';

/**
 * Supabase service_role クライアント（サーバ専用）
 *
 * - NEXT_PUBLIC_SUPABASE_URL から project_id を抽出し、
 *   Core API `GET /api/credentials/supabase_service_role?scope_key=<project_id>` で
 *   service_role key を取得する (env 直参照ゼロ、credential 集中化 goal #3)。
 * - service_role は RLS をバイパスするため、絶対にクライアントに露出させない
 * - Vercel 環境では関数 invocation ごとに新しいインスタンスを作る方針（接続プール無し）
 * - キャッシュは Promise レベルで保持し、複数 caller が並走しても 1 度のみ Core 解決
 *
 * 設計レビュー: codex APPROVE (2026-05-18, Wave 2 A 修正版 v2)
 */

let cachedClient: Promise<SupabaseClient> | null = null;

function extractProjectId(supabaseUrl: string): string {
  // https://<project_id>.supabase.co → <project_id>
  const m = supabaseUrl.match(/^https?:\/\/([^.]+)\./);
  if (!m) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL から project_id を抽出できません (https://<project_id>.supabase.co 形式が必要)',
    );
  }
  return m[1];
}

async function buildClient(): Promise<SupabaseClient> {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!rawUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  const url = rawUrl.replace(/\s+$/, '');
  const projectId = extractProjectId(url);

  const cred = await getCredential<{ service_key?: string; service_role_key?: string }>(
    'supabase_service_role',
    projectId,
  );
  // credential_service_definitions の field 名は `service_key` を canonical とする
  // (migration 20260512040000)。`service_role_key` という旧/別名も実態対応のため許容。
  const key =
    cred.credentials.service_key ?? cred.credentials.service_role_key ?? '';
  if (!key) {
    throw new Error(
      `Core credential supabase_service_role (scope_key=${projectId}) に service_key (or service_role_key) フィールドが含まれていません`,
    );
  }

  return createClient(url, key.replace(/\s+$/, ''), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * service_role 権限の Supabase Client を返す。
 * Core API 経由で credential を解決するため async。
 *
 * - 解決後の client はモジュールスコープで Promise キャッシュ (コールドスタートで 1 回のみ Core 呼び出し)
 * - getCredential 内部に 5 分 TTL のキャッシュもあるが、ここではプロセス寿命単位で client を保持
 */
export async function getSupabaseAdmin(): Promise<SupabaseClient> {
  if (!cachedClient) {
    cachedClient = buildClient().catch((err) => {
      // 失敗時はキャッシュをクリアして次回再試行可能にする
      cachedClient = null;
      throw err;
    });
  }
  return cachedClient;
}
