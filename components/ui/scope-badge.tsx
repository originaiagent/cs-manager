import { Building2, Package, type LucideIcon } from 'lucide-react';
import ChannelBadge from './channel-badge';

interface Props {
  scope: 'company' | 'store' | 'product' | string;
  storeId?: string | null;
  storeDisplayName?: string | null;
  productId?: string | null;
  productName?: string | null;
}

const SCOPE_STYLE: Record<
  string,
  { Icon: LucideIcon; classes: string; label: string }
> = {
  company: {
    Icon: Building2,
    classes: 'bg-sky-50 text-sky-700 border-sky-200',
    label: '会社共通',
  },
  product: {
    Icon: Package,
    classes: 'bg-violet-50 text-violet-700 border-violet-200',
    label: '商品別',
  },
};

const FALLBACK = {
  classes: 'bg-gray-50 text-gray-600 border-gray-200',
  Icon: Package,
  label: '不明',
};

export default function ScopeBadge({
  scope,
  storeId,
  storeDisplayName,
  productId,
  productName,
}: Props) {
  if (scope === 'store' && storeId) {
    return <ChannelBadge code={storeId} displayName={storeDisplayName ?? storeId} />;
  }
  const style = SCOPE_STYLE[scope] ?? FALLBACK;
  const Icon = style.Icon;
  const trailingLabel =
    scope === 'product'
      ? productName
        ? `${style.label}: ${productName}`
        : productId
          ? `${style.label}: id=${productId}`
          : style.label
      : style.label;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${style.classes}`}
    >
      <Icon size={10} strokeWidth={2} />
      <span>{trailingLabel}</span>
    </span>
  );
}
