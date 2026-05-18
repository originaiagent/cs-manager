import { notFound } from 'next/navigation';
import PageHeader from '@/components/ui/page-header';
import { getSupabaseAdmin } from '@/lib/db/supabase-admin';
import RecordForm, { type RecordFormInitial } from '../_components/record-form';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

export default async function EditCustomerRecordPage({
  params,
}: {
  params: { id: string };
}) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from('customer_service_records')
    .select('*')
    .eq('id', params.id)
    .maybeSingle();
  if (error || !data) notFound();

  const initial: RecordFormInitial = {
    id: data.id,
    product_id: data.product_id ?? null,
    product_name_text: data.product_name_text ?? '',
    variation_text: data.variation_text ?? '',
    recipient_name: data.recipient_name ?? '',
    recipient_honorific: data.recipient_honorific ?? '様',
    order_number: data.order_number ?? '',
    order_channel: data.order_channel ?? '',
    action_type: data.action_type ?? 'reply_only',
    amazon_gift_amount: data.amazon_gift_amount ?? null,
    reship_tracking: data.reship_tracking ?? '',
    record_date: data.record_date ?? '',
    line_account: data.line_account ?? '',
    memo: data.memo ?? '',
    defect_type: data.defect_type ?? '',
    ticket_id: data.ticket_id ?? null,
  };

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="対応記録 編集"
        description={`record_id: ${data.id}`}
      />
      <RecordForm mode="edit" initial={initial} />
    </div>
  );
}
