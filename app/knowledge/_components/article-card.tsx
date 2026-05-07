import Link from 'next/link';
import { Eye } from 'lucide-react';
import ScopeBadge from '@/components/ui/scope-badge';
import StatusBadge from '@/components/ui/status-badge';
import { formatRelative } from '@/lib/format';

interface Props {
  article: {
    id: string;
    title: string;
    question: string | null;
    answer: string | null;
    storage_scope: string;
    storage_store_id: string | null;
    storage_product_id: string | null;
    applies_to_stores: string[];
    applies_to_products: string[];
    tags: string[];
    status: string;
    reference_count: number;
    updated_at: string;
  };
  storeDisplayMap: Record<string, string>;
  productNameMap: Record<string, string>;
}

const SCOPE_BAR: Record<string, string> = {
  company: 'border-l-sky-400',
  store: 'border-l-pink-400',
  product: 'border-l-violet-400',
};

export default function ArticleCard({
  article,
  storeDisplayMap,
  productNameMap,
}: Props) {
  const bar = SCOPE_BAR[article.storage_scope] ?? 'border-l-gray-300';

  return (
    <Link
      href={`/knowledge/${article.id}`}
      className={`block rounded-xl border border-l-4 ${bar} border-gray-200 bg-white p-4 hover:border-brand-500 hover:shadow-sm transition-all`}
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <ScopeBadge
            scope={article.storage_scope as any}
            storeId={article.storage_store_id}
            storeDisplayName={
              article.storage_store_id
                ? storeDisplayMap[article.storage_store_id]
                : null
            }
            productId={article.storage_product_id}
            productName={
              article.storage_product_id
                ? productNameMap[article.storage_product_id]
                : null
            }
          />
          <StatusBadge status={article.status} variant="knowledge" />
        </div>
        <div className="text-[10px] text-gray-400 shrink-0 flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <Eye size={10} />
            {article.reference_count}
          </span>
          <span>{formatRelative(article.updated_at)}</span>
        </div>
      </div>
      <h3 className="text-sm font-medium text-gray-900 mb-1">{article.title}</h3>
      {article.question && (
        <p className="text-xs text-gray-600 line-clamp-1 mb-1">
          Q: {article.question}
        </p>
      )}
      {article.answer && (
        <p className="text-xs text-gray-500 line-clamp-2">{article.answer}</p>
      )}
      <div className="flex items-center gap-1 flex-wrap mt-2">
        {article.tags.slice(0, 5).map((t) => (
          <span
            key={t}
            className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600"
          >
            #{t}
          </span>
        ))}
        {article.applies_to_products.length > 0 && (
          <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] text-violet-700">
            適用: {article.applies_to_products.length}製品
          </span>
        )}
      </div>
    </Link>
  );
}
