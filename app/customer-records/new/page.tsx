import PageHeader from '@/components/ui/page-header';
import RecordForm from '../_components/record-form';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: {
    ticket_id?: string;
    recipient_name?: string;
    product_name?: string;
  };
}

export default function NewCustomerRecordPage({ searchParams }: Props) {
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="対応記録 新規登録"
        description="顧客対応 1 件分の記録を入力してください"
      />
      <RecordForm
        mode="create"
        defaultTicketId={searchParams.ticket_id ?? null}
        defaultRecipientName={searchParams.recipient_name ?? null}
        defaultProductName={searchParams.product_name ?? null}
      />
    </div>
  );
}
