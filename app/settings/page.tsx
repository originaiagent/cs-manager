import PageHeader from '@/components/ui/page-header';

export default function SettingsPage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="設定"
        description="チャネル接続情報・通知設定など (Phase 2 で実装)"
      />
      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
        設定ページは現在準備中です。
      </div>
    </div>
  );
}
