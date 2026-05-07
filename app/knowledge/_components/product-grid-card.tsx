import Link from 'next/link';
import { Package, Eye } from 'lucide-react';
import { formatRelative } from '@/lib/format';

interface Props {
  productId: string;
  productName: string;
  variation?: string | null;
  resolved: boolean;
  articleCount: number;
  totalReferenceCount: number;
  latestUpdatedAt: string | null;
  topTags: string[];
}

export default function ProductGridCard({
  productId,
  productName,
  variation,
  resolved,
  articleCount,
  totalReferenceCount,
  latestUpdatedAt,
  topTags,
}: Props) {
  return (
    <Link
      href={`/knowledge?scope=product&product_id=${encodeURIComponent(productId)}`}
      className="block rounded-xl border-l-4 border-l-violet-400 border-gray-200 border bg-white p-4 hover:border-brand-500 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Package size={14} className="text-violet-500 shrink-0" />
            <p className="text-sm font-medium text-gray-900 truncate">
              {productName}
              {!resolved && (
                <span className="ml-1 text-[10px] text-amber-600">(名寄せ失敗)</span>
              )}
            </p>
          </div>
          {variation && (
            <p className="text-[11px] text-gray-500 mt-0.5 ml-6">{variation}</p>
          )}
          <p className="text-[10px] text-gray-400 mt-0.5 ml-6">product_id: {productId}</p>
        </div>
        <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-violet-100 text-violet-700 text-[11px] font-semibold">
          {articleCount}
        </span>
      </div>
      <div className="flex items-center gap-1 flex-wrap mt-2.5">
        {topTags.slice(0, 3).map((t) => (
          <span
            key={t}
            className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600"
          >
            #{t}
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 mt-2 text-[10px] text-gray-400">
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
