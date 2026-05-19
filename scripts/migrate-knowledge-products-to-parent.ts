#!/usr/bin/env tsx
/**
 * knowledge_articles の storage_product_id (旧子 products.id) を親 product_groups.id に正規化。
 *
 * - WHERE storage_scope='product' AND storage_product_id IS NOT NULL AND deleted_at IS NULL のみ対象 (idempotent)
 * - child-first 判定: products と product_groups の ID 名前空間は別なので、まず child products として照会する。
 *   - child products でヒット → legacy 子 ID。parent group_id に置換 + applies_to_products に元 id を append (重複防止)
 *   - child products で 404 → 次に parent product-groups として照会
 *     - 親としてヒット → 既に migrated 済み (skip)
 *     - 親としても 404 → Core から削除済み (skip + warn)
 *
 * dry-run: --dry-run
 */
import { createClient } from '@supabase/supabase-js';

const isDryRun = process.argv.includes('--dry-run');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\s+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/\s+$/, '');
const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');

if (!SUPABASE_URL || !SUPABASE_KEY || !CORE_API_URL || !INTERNAL_API_KEY) {
  console.error('Missing env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const headers = { 'X-Internal-API-Key': INTERNAL_API_KEY!, Accept: 'application/json' };

async function isParentGroup(id: string): Promise<boolean> {
  const r = await fetch(`${CORE_API_URL!.replace(/\/$/, '')}/api/v1/master/product-groups/${id}`, {
    headers,
  });
  return r.ok;
}
async function getProduct(id: string): Promise<{ product_group_id: number | null } | null> {
  const r = await fetch(`${CORE_API_URL!.replace(/\/$/, '')}/api/v1/master/products/${id}`, {
    headers,
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data ?? j;
}

async function main() {
  console.log(`[migrate-knowledge] dryRun=${isDryRun}`);
  const { data: rows, error } = await sb
    .from('knowledge_articles')
    .select('id, storage_product_id, applies_to_products')
    .eq('storage_scope', 'product')
    .not('storage_product_id', 'is', null)
    .is('deleted_at', null);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`target rows: ${rows?.length ?? 0}`);

  let migrated = 0;
  let alreadyParent = 0;
  let notFound = 0;
  for (const r of rows ?? []) {
    const id = String(r.storage_product_id);
    // child-first: products テーブルとして照会
    const product = await getProduct(id);
    if (product) {
      const parentId = product.product_group_id;
      if (parentId == null) {
        notFound += 1;
        console.warn(`  row=${r.id} child=${id} has null product_group_id -> skip`);
        continue;
      }
      // applies_to_products 重複防止
      const existing: string[] = Array.isArray(r.applies_to_products) ? r.applies_to_products : [];
      const newApplies = existing.includes(id) ? existing : [...existing, id];
      if (!isDryRun) {
        const { error: upErr } = await sb
          .from('knowledge_articles')
          .update({ storage_product_id: String(parentId), applies_to_products: newApplies })
          .eq('id', r.id);
        if (upErr) {
          console.error(`UPDATE ${r.id} error:`, upErr.message);
          continue;
        }
      }
      migrated += 1;
      console.log(`  row=${r.id} child=${id} -> parent=${parentId}, applies_to_products+=${id}`);
      continue;
    }
    // child でヒットしなかった → parent group として照会
    if (await isParentGroup(id)) {
      alreadyParent += 1;
      console.log(`  row=${r.id} storage_product_id=${id} -> already parent group, skip`);
      continue;
    }
    notFound += 1;
    console.warn(`  row=${r.id} storage_product_id=${id} NOT FOUND in Core (neither child nor group) -> skip`);
  }
  console.log(`[migrate-knowledge] done. migrated=${migrated}, alreadyParent=${alreadyParent}, notFound=${notFound}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
