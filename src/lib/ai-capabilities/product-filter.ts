import { searchProductsByName } from '@/lib/core-client';
import { resolveGroupChildIds } from '@/lib/product-resolver';

export interface ResolvedProductFilter {
  product_id?: string;
  product?: string;
  resolved_ok: boolean;
  error?: string;
  matched_count: number;
  childIds: Set<string>;
  groupIds: Set<string>;
  active: boolean;
}

export async function resolveProductFilter(input: {
  product_id?: string | null;
  product?: string | null;
}): Promise<ResolvedProductFilter> {
  const productId = input.product_id?.trim() || undefined;
  const product = input.product?.trim() || undefined;

  if (productId) {
    const children = await resolveGroupChildIds([productId]);
    const expanded = children.get(productId) ?? [];
    return {
      product_id: productId,
      ...(product ? { product } : {}),
      resolved_ok: true,
      matched_count: expanded.length || 1,
      childIds: new Set(expanded.length > 0 ? expanded : [productId]),
      groupIds: new Set([productId]),
      active: true,
    };
  }

  if (product) {
    const result = await searchProductsByName(product);
    if (!result.ok) {
      return {
        product,
        resolved_ok: false,
        ...(result.error ? { error: result.error } : {}),
        matched_count: 0,
        childIds: new Set(),
        groupIds: new Set(),
        active: true,
      };
    }
    const childIds = new Set<string>();
    const groupIds = new Set<string>();
    for (const row of result.products) {
      if (row.id != null) childIds.add(String(row.id));
      if (row.product_group_id != null) groupIds.add(String(row.product_group_id));
    }
    return {
      product,
      resolved_ok: true,
      matched_count: result.products.length,
      childIds,
      groupIds,
      active: true,
    };
  }

  return {
    resolved_ok: true,
    matched_count: 0,
    childIds: new Set(),
    groupIds: new Set(),
    active: false,
  };
}

export function matchesProductFilter(
  filter: ResolvedProductFilter,
  row: { group_id: string; variation_child_id: string | null },
): boolean {
  if (!filter.active) return true;
  return (
    filter.groupIds.has(row.group_id) ||
    (row.variation_child_id != null && filter.childIds.has(row.variation_child_id))
  );
}

export function productFilterOutput(filter: ResolvedProductFilter) {
  return {
    ...(filter.product_id ? { product_id: filter.product_id } : {}),
    ...(filter.product ? { product: filter.product } : {}),
    resolved_ok: filter.resolved_ok,
    ...(filter.error ? { error: filter.error } : {}),
    matched_count: filter.matched_count,
  };
}
