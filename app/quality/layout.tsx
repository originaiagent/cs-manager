import PageHeader from '@/components/ui/page-header';
import TabNav from '@/components/ui/tab-nav';

const TABS = [
  { href: '/quality/defect-rate', label: '不良率' },
  { href: '/quality/improvement-suggestions', label: 'Q&A・説明書改善' },
  { href: '/quality/product-proposals', label: '製品改善' },
];

export default function QualityLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-6xl">
      <PageHeader
        title="品質分析"
        description="不良率モニタリング・改善提案・製品改善提案"
      />
      <TabNav tabs={TABS} />
      {children}
    </div>
  );
}
