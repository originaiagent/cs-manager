import { User, Mail, Hash, Package } from 'lucide-react';
import type { CoreProduct } from '@/lib/core-client';

interface Props {
  customerName: string | null;
  customerEmail: string | null;
  orderNumber: string | null;
  productId: string | null;
  product: CoreProduct | null;
  productError: string | null;
}

export default function CustomerInfo({
  customerName,
  customerEmail,
  orderNumber,
  productId,
  product,
  productError,
}: Props) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <p className="text-[11px] text-gray-400 font-medium tracking-wider mb-3">CUSTOMER</p>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <User size={14} className="text-gray-400 shrink-0" />
            <span className="text-gray-900">{customerName ?? '不明'}</span>
          </div>
          {customerEmail && (
            <div className="flex items-center gap-2">
              <Mail size={14} className="text-gray-400 shrink-0" />
              <span className="text-gray-600 truncate">{customerEmail}</span>
            </div>
          )}
          {orderNumber && (
            <div className="flex items-center gap-2">
              <Hash size={14} className="text-gray-400 shrink-0" />
              <span className="text-gray-600">{orderNumber}</span>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <p className="text-[11px] text-gray-400 font-medium tracking-wider mb-3">PRODUCT</p>
        {!productId ? (
          <div className="text-sm text-gray-400">製品情報なし</div>
        ) : product ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <Package size={14} className="text-gray-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-gray-900 font-medium">
                  {product.product_name ?? '(product_name 不明)'}
                </p>
                {product.variation && (
                  <p className="text-xs text-gray-500 mt-0.5">{product.variation}</p>
                )}
                <p className="text-[11px] text-gray-400 mt-1">
                  product_id: {String(product.id)}
                  {product.jan_code && <> ・ JAN {product.jan_code}</>}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm">
            <p className="text-amber-600">製品情報取得失敗</p>
            <p className="text-[11px] text-gray-400 mt-1">
              product_id: {productId}
              {productError ? ` ・ ${productError}` : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
