#!/usr/bin/env tsx
/**
 * customer_service_records の旧 product_id (子 products.id) を親 product_groups.id に正規化。
 *
 * - WHERE variation_id IS NULL AND product_id IS NOT NULL のみ対象 (idempotent)
 * - child-first 判定: products と product_groups の ID 名前空間は別なので、まず child products で照会する。
 *   - child products でヒット → legacy 子 ID。SET product_id=group_id, variation_id=old, variation_jan
 *   - child products で 404 → 次に parent product-groups として照会
 *     - 親としてヒット → 新 UI の親のみレコード (parent-only) や migration 済み。何もしない (skip)
 *     - 親としても 404 → Core から削除された child の可能性。SET product_id=NULL, variation_id=old
 * - dry-run: --dry-run flag で UPDATE をスキップ、ログのみ
 *
 * 使用: tsx scripts/migrate-customer-records-to-parent.ts [--dry-run]
 * 必要 env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CORE_API_URL, INTERNAL_API_KEY
 */
import { createClient } from '@supabase/supabase-js';

const isDryRun = process.argv.includes('--dry-run');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\s+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/\s+$/, '');
const CORE_API_URL = process.env.CORE_API_URL?.replace(/\s+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY?.replace(/\s+$/, '');

if (!SUPABASE_URL || !SUPABASE_KEY || !CORE_API_URL || !INTERNAL_API_KEY) {
  console.error('Missing env: SUPABASE_URL/KEY or CORE_API_URL/INTERNAL_API_KEY');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const headers = { 'X-Internal-API-Key': INTERNAL_API_KEY!, Accept: 'application/json' };

async function isParentGroup(id: number): Promise<boolean> {
  const r = await fetch(`${CORE_API_URL!.replace(/\/$/, '')}/api/v1/master/product-groups/${id}`, { headers });
  return r.ok;
}

async function main() {
  console.log(`[migrate-customer-records] dryRun=${isDryRun}`);
  const { data: rows, error } = await sb
    .from('customer_service_records')
    .select('id, product_id')
    .is('variation_id', null)
    .not('product_id', 'is', null);
  if (error) {
    console.error('SELECT error:', error.message);
    process.exit(1);
  }
  console.log(`target rows: ${rows?.length ?? 0}`);

  let resolved = 0;
  let alreadyParent = 0;
  let notFound = 0;
  let updated = 0;
  for (const r of rows ?? []) {
    const oldProductId = r.product_id as number;
    // child-first: products として照会
    const url = `${CORE_API_URL!.replace(/\/$/, '')}/api/v1/master/products/${oldProductId}`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const j = await res.json();
      const product = j?.data ?? j;
      const newParentId = product?.product_group_id ?? null;
      const janCode = product?.jan_code ?? null;
      resolved += 1;
      if (!isDryRun) {
        const { error: upErr } = await sb
          .from('customer_service_records')
          .update({ product_id: newParentId, variation_id: oldProductId, variation_jan: janCode })
          .eq('id', r.id);
        if (upErr) console.error(`UPDATE ${r.id} error:`, upErr.message);
        else updated += 1;
      }
      console.log(
        `  row=${r.id} oldProductId=${oldProductId} -> parent=${newParentId}, variation=${oldProductId}, jan=${janCode}`,
      );
      continue;
    }
    // child でヒットしなかった → parent group として照会
    if (await isParentGroup(oldProductId)) {
      alreadyParent += 1;
      console.log(`  row=${r.id} product_id=${oldProductId} -> already parent group (parent-only record), skip`);
      continue;
    }
    // どちらにも該当しない (Core から削除された child product の可能性)
    notFound += 1;
    if (!isDryRun) {
      const { error: upErr } = await sb
        .from('customer_service_records')
        .update({ product_id: null, variation_id: oldProductId })
        .eq('id', r.id);
      if (upErr) console.error(`UPDATE ${r.id} error:`, upErr.message);
      else updated += 1;
    }
    console.warn(
      `  row=${r.id} oldProductId=${oldProductId} NOT FOUND in Core (neither child nor group) -> variation_id=${oldProductId}, product_id=NULL`,
    );
  }
  console.log(`[migrate-customer-records] done. resolved=${resolved}, alreadyParent=${alreadyParent}, notFound=${notFound}, updated=${updated}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
