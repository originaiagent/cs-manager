#!/usr/bin/env tsx
/**
 * customer_service_records の旧 product_id (子 products.id) を親 product_groups.id に正規化。
 *
 * ## 重要: ID 名前空間衝突への対応
 * products テーブルと product_groups テーブルは ID 名前空間が分離しており、numeric overlap が起きうる。
 * 一度 migration を走らせると product_id は parent group_id になるが、その値が同時に child products.id と
 * numeric match する可能性がある。そのため child-first 判定だと再実行 (または新 UI の parent-only レコード) で破損する。
 *
 * 本スクリプトは「parent-first + ambiguous skip」アプローチで idempotent を担保:
 *   - parent product-groups/:id でヒット → 既に migrated 済み or 新 UI 保存の parent-only レコード。skip
 *   - parent で 404 → child products/:id を照会
 *     - child でヒット → legacy 子 ID。SET product_id=group_id, variation_id=old, variation_jan
 *     - child でも 404 → Core から削除済み。SET product_id=NULL, variation_id=old
 *
 * トレードオフ: 「legacy child ID と parent group ID が numeric overlap」の rare ケースは under-migrate (skip)。
 * 手動 SQL UPDATE 推奨。corrupt よりは under-migrate が安全。
 *
 * 安全装置:
 *   - 404 と「auth/500/503/network」を明確に区別。後者は destructive fallback に進まず即 abort。
 *   - Supabase select は range() で 1000 件ずつページング (PostgREST デフォルト上限回避)。
 *
 * dry-run: --dry-run flag で UPDATE をスキップ、ログのみ
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
const PAGE_SIZE = 1000;

type LookupResult = { kind: 'found'; data: any } | { kind: 'not-found' } | { kind: 'error'; status: number; text: string };

async function lookupParentGroup(id: number): Promise<LookupResult> {
  const r = await fetch(`${CORE_API_URL!.replace(/\/$/, '')}/api/v1/master/product-groups/${id}`, { headers });
  if (r.ok) return { kind: 'found', data: null };
  if (r.status === 404) return { kind: 'not-found' };
  const text = await r.text().catch(() => '');
  return { kind: 'error', status: r.status, text: text.slice(0, 200) };
}

async function lookupChildProduct(id: number): Promise<LookupResult> {
  const r = await fetch(`${CORE_API_URL!.replace(/\/$/, '')}/api/v1/master/products/${id}`, { headers });
  if (r.ok) {
    const j = await r.json();
    return { kind: 'found', data: j?.data ?? j };
  }
  if (r.status === 404) return { kind: 'not-found' };
  const text = await r.text().catch(() => '');
  return { kind: 'error', status: r.status, text: text.slice(0, 200) };
}

async function fetchAllTargetRows(): Promise<Array<{ id: string; product_id: number }>> {
  const all: Array<{ id: string; product_id: number }> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('customer_service_records')
      .select('id, product_id')
      .is('variation_id', null)
      .not('product_id', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error(`SELECT error at offset=${offset}:`, error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ id: string; product_id: number }>;
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function main() {
  console.log(`[migrate-customer-records] dryRun=${isDryRun}`);
  const rows = await fetchAllTargetRows();
  console.log(`target rows: ${rows.length}`);

  let resolved = 0;
  let alreadyParent = 0;
  let notFound = 0;
  let updated = 0;
  for (const r of rows) {
    const oldProductId = r.product_id;
    // parent-first: parent group として照会 (idempotent 担保 + 新 UI parent-only 保護)
    const pg = await lookupParentGroup(oldProductId);
    if (pg.kind === 'error') {
      console.error(`[FATAL] Core lookup error (parent-groups/${oldProductId}): status=${pg.status} text=${pg.text}`);
      console.error(`  destructive fallback を避けるため abort。INTERNAL_API_KEY / Core 状態を確認してから再実行してください。`);
      process.exit(2);
    }
    if (pg.kind === 'found') {
      alreadyParent += 1;
      console.log(`  row=${r.id} product_id=${oldProductId} -> parent group exists, skip (already migrated or new parent-only record)`);
      continue;
    }
    // parent で 404 → child products として照会
    const cp = await lookupChildProduct(oldProductId);
    if (cp.kind === 'error') {
      console.error(`[FATAL] Core lookup error (products/${oldProductId}): status=${cp.status} text=${cp.text}`);
      console.error(`  destructive fallback を避けるため abort。INTERNAL_API_KEY / Core 状態を確認してから再実行してください。`);
      process.exit(2);
    }
    if (cp.kind === 'found') {
      const product = cp.data;
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
    // 両方 404 (Core から削除された child product の可能性)
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
  console.log(
    `[migrate-customer-records] done. resolved=${resolved}, alreadyParent=${alreadyParent}, notFound=${notFound}, updated=${updated}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
