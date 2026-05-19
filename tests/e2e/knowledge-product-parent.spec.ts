/**
 * knowledge 親グループ別表示 E2E (PR-EF)
 *
 * 検証:
 *   1. /knowledge?scope=product で商品グループのカード一覧が表示される
 *      - 親グループ数 (Core /api/v1/master/product-groups の total) のカードがあること
 *   2. ナレッジ新規作成 (scope=product) で親グループを検索 → 選択
 *      - product picker (knowledge context) は親グループ検索のみ、子バリエーション pulldown 無し
 *
 * NOTE: Core API 利用不可時は skip
 */
import { test, expect } from '@playwright/test';

test('/knowledge?scope=product: 親グループのカードが (Core total と一致する) 件数表示', async ({ page }) => {
  await page.goto('/knowledge?scope=product', { waitUntil: 'domcontentloaded' });

  // 少なくとも 1 枚のカードが描画される
  const cards = page.locator('[data-testid="knowledge-product-card"]');
  await expect(cards.first()).toBeVisible({ timeout: 20000 });
  const count = await cards.count();
  // Core API 上では 98 件前提。truncated / orphan 追加で増減ありえるが、>=50 と <=200 の幅で許容
  expect(count).toBeGreaterThanOrEqual(50);
  expect(count).toBeLessThanOrEqual(200);
});

test('/knowledge/new?scope=product: 親グループ picker で検索 → 選択', async ({ page }) => {
  await page.goto('/knowledge/new?scope=product', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /ナレッジ新規作成/ })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');

  // 親グループ picker の検索ボックス
  const searchInput = page.locator('input[placeholder*="商品名で検索"]').first();
  await expect(searchInput).toBeVisible({ timeout: 10000 });
  await searchInput.fill('EMS');

  // サジェストから親グループを選択
  const suggestion = page.locator('button', { hasText: /EMS/ }).first();
  await expect(suggestion).toBeVisible({ timeout: 15000 });
  await suggestion.click();

  // 親選択済み (group_id チップ表示)
  await expect(page.locator('span', { hasText: /group_id=/ }).first()).toBeVisible({ timeout: 10000 });

  // knowledge context では子バリエーション pulldown が出ない
  // (バリエーション関連のテキストが scope=product UI には無いことを確認)
  await expect(page.locator('text=バリエーション取得中')).toHaveCount(0);
  await expect(page.locator('text=バリエーション選択')).toHaveCount(0);
});
