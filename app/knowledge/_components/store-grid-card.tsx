import Link from 'next/link';
import { Eye } from 'lucide-react';
import ChannelBadge from '@/components/ui/channel-badge';
import { formatRelative } from '@/lib/format';

interface Props {
  storeCode: string;
  storeDisplayName: string;
  articleCount: number;
  totalReferenceCount: number;
  latestUpdatedAt: string | null;
  topTags: string[];
}

export default function StoreGridCard({
  storeCode,
  storeDisplayName,
  articleCount,
  totalReferenceCount,
  latestUpdatedAt,
  topTags,
}: Props) {
  return (
    <Link
      href={`/knowledge?scope=store&store_id=${encodeURIComponent(storeCode)}`}
      className="block rounded-xl border-l-4 border-l-pink-400 border-gray-200 border bg-white p-4 hover:border-brand-500 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <ChannelBadge code={storeCode} displayName={storeDisplayName} size="md" />
        <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-pink-100 text-pink-700 text-[11px] font-semibold">
          {articleCount}
        </span>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {topTags.slice(0, 3).map((t) => (
          <span
            key={t}
            className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600"
          >
            #{t}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 mt-3 text-[10px] text-gray-400">
        <span className="inline-flex items-center gap-1">
          <Eye size={10} />
          参照 {totalReferenceCount}
        </span>
        <span>
          {latestUpdatedAt ? `最終更新 ${formatRelative(latestUpdatedAt)}` : '更新なし'}
        </span>
      </div>
    </Link>
  );
}
