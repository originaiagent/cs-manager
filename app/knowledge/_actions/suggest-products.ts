'use server';

import { suggestProducts as _suggestProducts } from '@/lib/actions/suggest-products';

export async function suggestProducts(
  q: string,
): Promise<{
  ok: boolean;
  items?: Array<{ id: string; product_name: string; variation?: string | null }>;
  error?: string;
}> {
  return _suggestProducts(q);
}
