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

function normalize(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

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

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('customer_service_records')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, record: data });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const update: Record<string, any> = {};

  if ('product_name_text' in payload) {
    const v = normalize(payload.product_name_text);
    if (!v) return NextResponse.json({ ok: false, error: 'product_name_text required' }, { status: 400 });
    update.product_name_text = v;
  }
  if ('recipient_name' in payload) {
    const v = normalize(payload.recipient_name);
    if (!v) return NextResponse.json({ ok: false, error: 'recipient_name required' }, { status: 400 });
    update.recipient_name = v;
  }
  if ('action_type' in payload) {
    const v = normalize(payload.action_type);
    if (!v || !(ALLOWED_ACTION_TYPES as readonly string[]).includes(v)) {
      return NextResponse.json({ ok: false, error: 'invalid action_type' }, { status: 400 });
    }
    update.action_type = v;
  }
  if ('record_date' in payload) {
    const v = normalize(payload.record_date);
    if (!v || !isIsoDate(v)) {
      return NextResponse.json({ ok: false, error: 'invalid record_date' }, { status: 400 });
    }
    update.record_date = v;
  }
  if ('order_channel' in payload) {
    const v = normalize(payload.order_channel);
    if (v && !(ALLOWED_ORDER_CHANNELS as readonly string[]).includes(v)) {
      return NextResponse.json({ ok: false, error: 'invalid order_channel' }, { status: 400 });
    }
    update.order_channel = v;
  }
  if ('recipient_honorific' in payload) {
    update.recipient_honorific = normalize(payload.recipient_honorific) ?? '様';
  }
  if ('product_id' in payload) {
    if (payload.product_id == null || payload.product_id === '') {
      update.product_id = null;
    } else {
      const n = Number(payload.product_id);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return NextResponse.json({ ok: false, error: 'product_id must be integer' }, { status: 400 });
      }
      update.product_id = n;
    }
  }
  if ('amazon_gift_amount' in payload) {
    if (payload.amazon_gift_amount == null || payload.amazon_gift_amount === '') {
      update.amazon_gift_amount = null;
    } else {
      const n = Number(payload.amazon_gift_amount);
      if (!Number.isFinite(n)) {
        return NextResponse.json({ ok: false, error: 'amazon_gift_amount must be numeric' }, { status: 400 });
      }
      update.amazon_gift_amount = n;
    }
  }
  for (const k of ['variation_text', 'order_number', 'reship_tracking', 'line_account', 'memo', 'defect_type'] as const) {
    if (k in payload) update[k] = normalize(payload[k]);
  }
  if ('ticket_id' in payload) {
    const v = normalize(payload.ticket_id);
    if (v && !isUuid(v)) {
      return NextResponse.json({ ok: false, error: 'ticket_id must be a UUID' }, { status: 400 });
    }
    update.ticket_id = v;
  }
  if ('id' in params && !isUuid(params.id)) {
    // 念のため id 自体も validate
    return NextResponse.json({ ok: false, error: 'invalid id (UUID required)' }, { status: 400 });
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: 'no fields to update' }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('customer_service_records')
    .update(update)
    .eq('id', params.id)
    .select('*')
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, record: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = authorizeApiRoute(req, { tier: 'internal' });
  if (authError) return authError;

  const sb = getSupabaseAdmin();
  const { error } = await sb.from('customer_service_records').delete().eq('id', params.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
