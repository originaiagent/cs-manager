import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import { authorizeApiRoute } from '@/lib/auth/api-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ACTION_TYPES = [
  'reply_only',
  'reship_defect',
  'refund_defect',
  'reship_customer',
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

/**
 * `YYYY-MM-DD` の正規表現一致 + 実在日付チェック。
 * Date() で組み立てて Y/M/D が一致するか確認 (2026-99-99 を弾く)。
 */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export async function GET(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;

  const sp = req.nextUrl.searchParams;
  const sb = getSupabaseAdmin();
  let q = sb.from('customer_service_records').select('*');

  const productId = sp.get('product_id');
  if (productId) {
    const n = Number(productId);
    if (Number.isFinite(n)) q = q.eq('product_id', n);
  }
  const actionType = sp.get('action_type');
  if (actionType && (ALLOWED_ACTION_TYPES as readonly string[]).includes(actionType)) {
    q = q.eq('action_type', actionType);
  }
  const dateFrom = sp.get('date_from');
  if (dateFrom && isIsoDate(dateFrom)) q = q.gte('record_date', dateFrom);
  const dateTo = sp.get('date_to');
  if (dateTo && isIsoDate(dateTo)) q = q.lte('record_date', dateTo);
  const ticketId = sp.get('ticket_id');
  if (ticketId) q = q.eq('ticket_id', ticketId);

  const limitRaw = sp.get('limit');
  const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), 1000);
  q = q.order('record_date', { ascending: false }).order('created_at', { ascending: false }).limit(limit);

  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, records: data });
}

export async function POST(req: NextRequest) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
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

  // product_id は integer or null
  let productId: number | null = null;
  if (payload.product_id != null && payload.product_id !== '') {
    const n = Number(payload.product_id);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return NextResponse.json({ ok: false, error: 'product_id must be integer' }, { status: 400 });
    }
    productId = n;
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

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('customer_service_records')
    .insert(insert)
    .select('*')
    .single();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, record: data });
}
