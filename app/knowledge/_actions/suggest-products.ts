'use server';

import { suggestProducts as _suggestProducts } from '@/lib/actions/suggest-products';

/**
 * 既存 ProductSuggest 複数選択 (applies_to_products) 用の薄いラッパー。
 *
 * PR-EF で /api/products/suggest は親グループ検索に変更されたが、
 * applies_to_products の選択 UI (ProductSuggest) は構造変更しないため、
 * group_name を product_name にマップして従来 I/F 互換性を保つ。
 *
 * 結果として applies_to_products には親 group_id が格納される
 * (既存子 product_id データは admin script で正規化、または新規データのみで運用)。
 */
export async function suggestProducts(
  q: string,
): Promise<{
  ok: boolean;
  items?: Array<{ id: string; product_name: string; variation?: string | null }>;
  error?: string;
}> {
  const r = await _suggestProducts(q);
  if (!r.ok) return { ok: false, error: r.error };
  const items = (r.items ?? []).map((it) => ({
    id: it.id,
    product_name: it.group_name,
    variation: null,
  }));
  return { ok: true, items };
}
