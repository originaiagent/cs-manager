import Link from 'next/link';

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

/**
 * /knowledge?scope=product の商品カード。
 *
 * UI 簡素化 (2026-05-18): 商品名のみ表示。
 * variation / product_id / topTags / 参照数 / 最終更新 / article_count バッジは
 * すべて意図的に非表示。クリックで詳細遷移する Link のみ残す。
 */
export default function ProductGridCard({
  productId,
  productName,
}: Props) {
  return (
    <Link
      href={`/knowledge?scope=product&product_id=${encodeURIComponent(productId)}`}
      className="block rounded-xl border-l-4 border-l-violet-400 border-gray-200 border bg-white p-4 hover:border-brand-500 hover:shadow-sm transition-all"
      data-testid="knowledge-product-card"
    >
      <p className="text-sm font-medium text-gray-900 truncate">{productName}</p>
    </Link>
  );
}
