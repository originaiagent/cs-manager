/**
 * /knowledge?scope=product UI 簡素化 E2E
 *
 * 検証:
 *   1. /knowledge?scope=product の商品カード: 商品名のみ表示
 *      - article_count バッジ / variation / product_id / topTags / 参照数 / 最終更新 が DOM に存在しない
 *   2. /knowledge?scope=product&product_id=X のナレッジカード: タイトルのみ表示
 *      - ScopeBadge / StatusBadge / 参照数 (Eye) / formatRelative / Q行 / answer / tags / 適用バッジ が DOM に存在しない
 *      - 商品名プレフィックスがタイトル先頭から除去されている
 */
import { test, expect } from '@playwright/test';

test('/knowledge?scope=product カードは商品名のみ表示', async ({ page }) => {
  await page.goto('/knowledge?scope=product', { waitUntil: 'domcontentloaded' });

  // 少なくとも 1 枚の商品カードが描画されることを待つ
  const card = page.locator('[data-testid="knowledge-product-card"]').first();
  await expect(card).toBeVisible({ timeout: 15000 });

  // 1) Eye icon (参照数) はカード内に存在しない
  await expect(card.locator('svg.lucide-eye')).toHaveCount(0);
  // 2) Package icon (旧アイコン) はカード内に存在しない
  await expect(card.locator('svg.lucide-package')).toHaveCount(0);
  // 3) "product_id:" 文字列が無い
  await expect(card.locator('text=product_id')).toHaveCount(0);
  // 4) "参照" 文字列が無い
  await expect(card.locator('text=参照')).toHaveCount(0);
  // 5) "最終更新" 文字列が無い
  await expect(card.locator('text=最終更新')).toHaveCount(0);
  // 6) "(名寄せ失敗)" 文字列が無い
  await expect(card.locator('text=名寄せ失敗')).toHaveCount(0);
  // 7) Tag (#) を含む span が無い
  await expect(card.locator('span:has-text("#")')).toHaveCount(0);
});

test('/knowledge?scope=product&product_id=3 ナレッジカードはタイトルのみ表示', async ({ page }) => {
  await page.goto('/knowledge?scope=product&product_id=3', { waitUntil: 'domcontentloaded' });

  // 簡素化記事カードが描画されることを待つ
  const card = page.locator('[data-testid="knowledge-article-card-simplified"]').first();
  await expect(card).toBeVisible({ timeout: 15000 });

  // 1) Eye icon (参照数) なし
  await expect(card.locator('svg.lucide-eye')).toHaveCount(0);
  // 2) ScopeBadge (rounded-full ピンク/紫/青系) なし
  await expect(card.locator('span.rounded-full')).toHaveCount(0);
  // 3) "Q:" prefix なし
  await expect(card.locator('text=Q:')).toHaveCount(0);
  // 4) "適用:" バッジなし
  await expect(card.locator('text=適用:')).toHaveCount(0);
  // 5) タイトル <h3> はある
  await expect(card.locator('h3')).toHaveCount(1);
  // 6) タイトル先頭から商品名プレフィックス (クールリング) が除去されている
  //    元データ: 「クールリング サイズ違いの確認方法」「クールリング 効果が出ないときのチェック」 etc.
  const titles = await page.locator('[data-testid="knowledge-article-card-simplified"] h3').allTextContents();
  for (const t of titles) {
    expect(t.startsWith('クールリング'), `title "${t}" should not start with "クールリング"`).toBeFalsy();
  }
});
