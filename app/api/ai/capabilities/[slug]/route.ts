/**
 * GET /api/ai/capabilities/[slug] — capability の実データ (純データ・read 専用)。
 *
 * backlog 20a408eb「全ツール AI 能力カタログ」Stage2 ファンアウト。参照実装: ec-manager。
 * マニフェスト (lib/ai-capabilities/manifest.ts) で公開した concept の実データを返す。
 *
 * 認証: X-Internal-API-Key (全ツール共有の内部鍵)。authorizeAiManifestRequest が
 *       timing-safe に検証する。
 * 性質: read 専用・副作用なし・純データのみ (提案生成・書込なし)。既存の
 *       /api/customer-records GET と同一の read クエリ (customer_service_records) を
 *       再利用する。sessionAuth 画面 API・/api/mcp・書込経路は不可触。
 *
 * dispatch: 登録済 capability slug のみ対応。未登録 slug は 404 (fail-closed)。
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeAiManifestRequest } from '@/lib/ai-capabilities/internal-key-guard';
import { getCapability } from '@/lib/ai-capabilities/manifest';
import { applySearchFilters, parseSearchParams } from '@/app/customer-records/_lib/build-search-query';

// node:crypto を使う内部鍵ガードのため Node runtime を強制する。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// /api/customer-records GET と同一の action_type allowlist (回帰なし)。
const ALLOWED_ACTION_TYPES = [
  'reply_only',
  'reship_defect',
  'refund_defect',
  'reship_customer',
  'refund_customer',
  'addon_send',
  'relation_send',
] as const;

/**
 * capability: customer-service の実データ。
 * 既存 /api/customer-records GET と同じ read を行う純データ facade。
 */
async function readCustomerService(sp: URLSearchParams): Promise<NextResponse> {
  const sb = await getSupabaseAdmin();
  let q = sb.from('customer_service_records').select('*', { count: 'exact' });

  // product / recipient / order の ILIKE + date_from / date_to (helper 経由・既存と同一)。
  const search = parseSearchParams(sp);
  q = applySearchFilters(q, search);

  // action_type の完全一致 (allowlist 内のみ)。
  const actionType = sp.get('action_type');
  if (actionType && (ALLOWED_ACTION_TYPES as readonly string[]).includes(actionType)) {
    q = q.eq('action_type', actionType);
  }

  q = q.order('record_date', { ascending: false }).order('created_at', { ascending: false });

  // limit: 既定 200 / 最小 1 / 最大 1000 (既存 GET の後方互換 limit と同一クランプ)。
  const limitRaw = sp.get('limit');
  const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), 1000);
  q = q.limit(limit);

  const { data, error, count } = await q;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, records: data ?? [], count: count ?? 0 }, { status: 200 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const authError = await authorizeAiManifestRequest(req);
  if (authError) return authError;

  const slug = params.slug;
  const capability = getCapability(slug);
  if (!capability) {
    return NextResponse.json({ ok: false, error: 'Unknown capability' }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  switch (slug) {
    case 'customer-service':
      return readCustomerService(sp);
    default:
      // manifest に登録済だが dispatch 未実装 (fail-closed)。
      return NextResponse.json({ ok: false, error: 'Capability not implemented' }, { status: 404 });
  }
}
