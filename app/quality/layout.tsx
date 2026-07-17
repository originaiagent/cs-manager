import PageHeader from '@/components/ui/page-header';
import TabNav from '@/components/ui/tab-nav';

// 製品改善タブは廃止 (工場エビデンス化 C3b-1)。UI 導線のみ断ち、
// /api/product-proposals ルート・DB テーブルは残置 (契約どおり)
const TABS = [
  { href: '/quality/defect-rate', label: '不良率' },
  { href: '/quality/improvement-suggestions', label: 'Q&A・説明書改善' },
];

export default function QualityLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="品質分析"
        description="不良率モニタリング・改善提案"
      />
      <TabNav tabs={TABS} />
      {children}
    </div>
  );
}
