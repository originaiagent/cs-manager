import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeInternalApiRoute } from '@/lib/auth/api-auth';
import {
  applySearchFilters,
  isIsoDate,
  parsePagination,
  parseSearchParams,
} from '@/app/customer-records/_lib/build-search-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ACTION_TYPES = [
  'reply_only',
  'reship_defect',
  'refund_defect',
  'reship_customer',
  'refund_customer',
  'addon_send',
  'relation_send',
] as const;
const ALLOWED_ORDER_CHANNELS = ['amazon', 'rakuten', 'yahoo', 'self', 'other'] as const;

/**
 * 空文字 / undefined / null → null へ正規化。
 * 空文字を NOT NULL でない optional フィールドに渡すと意図しないデータが入るため正規化必須。
 */
function normalize(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export async function GET(req: NextRequest) {
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;

  const sp = req.nextUrl.searchParams;
  const sb = await getSupabaseAdmin();
  let q = sb.from('customer_service_records').select('*', { count: 'exact' });

  // 既存 (後方互換): product_id / action_type / ticket_id / date_from / date_to
  const productId = sp.get('product_id');
  if (productId) {
    const n = Number(productId);
    if (Number.isFinite(n)) q = q.eq('product_id', n);
  }
  const actionType = sp.get('action_type');
  if (actionType && (ALLOWED_ACTION_TYPES as readonly string[]).includes(actionType)) {
    q = q.eq('action_type', actionType);
  }
  const ticketId = sp.get('ticket_id');
  if (ticketId) q = q.eq('ticket_id', ticketId);

  // 新規: product / recipient / order の ILIKE + date_from / date_to (helper 経由)
  // date_from / date_to は helper 内で isIsoDate チェック済み、不正値は無視される。
  const search = parseSearchParams(sp);
  q = applySearchFilters(q, search);

  // pagination: `limit` 指定があれば後方互換でそれを優先、無ければ page / page_size
  const limitRaw = sp.get('limit');
  q = q.order('record_date', { ascending: false }).order('created_at', { ascending: false });

  if (limitRaw != null && limitRaw !== '') {
    // 後方互換: limit を尊重 (offset 無し、最大 1000)
    const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), 1000);
    q = q.limit(limit);
  } else {
    const { page, pageSize } = parsePagination(sp);
    const offset = (page - 1) * pageSize;
    q = q.range(offset, offset + pageSize - 1);
  }

  const { data, error, count } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, records: data, count: count ?? 0 });
}

export async function POST(req: NextRequest) {
  const authError = await authorizeInternalApiRoute(req);
  if (authError) return authError;

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  // NOT NULL バリデーション
  const productNameText = normalize(payload.product_name_text);
  if (!productNameText) {
    return NextResponse.json({ ok: false, error: 'product_name_text required' }, { status: 400 });
  }
  const recipientName = normalize(payload.recipient_name);
  if (!recipientName) {
    return NextResponse.json({ ok: false, error: 'recipient_name required' }, { status: 400 });
  }
  const actionType = normalize(payload.action_type);
  if (!actionType || !(ALLOWED_ACTION_TYPES as readonly string[]).includes(actionType)) {
    return NextResponse.json({ ok: false, error: 'invalid action_type' }, { status: 400 });
  }
  const recordDate = normalize(payload.record_date);
  if (!recordDate || !isIsoDate(recordDate)) {
    return NextResponse.json({ ok: false, error: 'invalid record_date (YYYY-MM-DD)' }, { status: 400 });
  }

  // optional 正規化
  const orderChannel = normalize(payload.order_channel);
  if (orderChannel && !(ALLOWED_ORDER_CHANNELS as readonly string[]).includes(orderChannel)) {
    return NextResponse.json({ ok: false, error: 'invalid order_channel' }, { status: 400 });
  }

  // product_id は integer or null (親 group_id)
  let productId: number | null = null;
  if (payload.product_id != null && payload.product_id !== '') {
    const n = Number(payload.product_id);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return NextResponse.json({ ok: false, error: 'product_id must be integer' }, { status: 400 });
    }
    productId = n;
  }

  // variation_id は integer or null (子 product_id)
  let variationId: number | null = null;
  if (payload.variation_id != null && payload.variation_id !== '') {
    const n = Number(payload.variation_id);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return NextResponse.json({ ok: false, error: 'variation_id must be integer' }, { status: 400 });
    }
    variationId = n;
  }

  // amazon_gift_amount は numeric or null
  let amazonGiftAmount: number | null = null;
  if (payload.amazon_gift_amount != null && payload.amazon_gift_amount !== '') {
    const n = Number(payload.amazon_gift_amount);
    if (!Number.isFinite(n)) {
      return NextResponse.json({ ok: false, error: 'amazon_gift_amount must be numeric' }, { status: 400 });
    }
    amazonGiftAmount = n;
  }

  // honorific は空なら default '様' を採用
  const recipientHonorific = normalize(payload.recipient_honorific) ?? '様';

  // ticket_id は UUID validate (空 → null、形式不正 → 400)
  const ticketIdRaw = normalize(payload.ticket_id);
  if (ticketIdRaw && !isUuid(ticketIdRaw)) {
    return NextResponse.json({ ok: false, error: 'ticket_id must be a UUID' }, { status: 400 });
  }
  const ticketId = ticketIdRaw;

  const insert = {
    product_id: productId,
    product_name_text: productNameText,
    variation_text: normalize(payload.variation_text),
    variation_id: variationId,
    variation_jan: normalize(payload.variation_jan),
    recipient_name: recipientName,
    recipient_honorific: recipientHonorific,
    order_number: normalize(payload.order_number),
    order_channel: orderChannel,
    action_type: actionType,
    amazon_gift_amount: amazonGiftAmount,
    reship_tracking: normalize(payload.reship_tracking),
    record_date: recordDate,
    line_account: normalize(payload.line_account),
    memo: normalize(payload.memo),
    defect_type: normalize(payload.defect_type),
    ticket_id: ticketId,
  };

  const sb = await getSupabaseAdmin();
  const { data, error } = await sb
    .from('customer_service_records')
    .insert(insert)
    .select('*')
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, record: data });
}
