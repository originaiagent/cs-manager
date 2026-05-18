/**
 * 品質分析・不良率粒度拡張 E2E (PR-C)
 *
 * 検証:
 *   - 月別期間 (period=monthly) で URL `?period=monthly&month=YYYY-MM` が機能
 *   - 月切替で表示行数が変化 (前月 ←→ 今月でデータが異なる)
 *   - 粒度切替 parent / variation で行数が変化 (variation で行が増える)
 *   - parent 粒度では「バリエーション」列が無い、variation 粒度では存在する
 *
 * 前提シード (PR-C ブランチで投入済):
 *   product_id=3 / variation_text=[Sサイズ, Mサイズ, NULL] の 4 件
 *   (うち 3 件は今月、1 件は前月)
 */
import { test, expect } from '@playwright/test';

test('quality: 月別期間が選べる + 月切替で行数が変化', async ({ page }) => {
  await page.goto('/quality/defect-rate?period=monthly&granularity=parent', {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('period-monthly')).toBeVisible({ timeout: 15000 });
  // 月別が active (bg-brand-500)
  await expect(page.getByTestId('period-monthly')).toHaveClass(/bg-brand-500/);
  // current-month バッジが表示
  await expect(page.getByTestId('current-month')).toBeVisible();
  const monthThis = await page.getByTestId('current-month').textContent();
  expect(monthThis).toMatch(/^\d{4}-\d{2}$/);

  const rowsThisMonth = await page.locator('[data-testid="defect-rate-row"]').count();

  // 「前月」ボタンをクリック (aria-label="前月")
  const prev = page.getByRole('link', { name: '前月' });
  await expect(prev).toBeVisible();
  await prev.click();
  await page.waitForLoadState('domcontentloaded');

  const monthPrev = await page.getByTestId('current-month').textContent();
  expect(monthPrev).not.toBe(monthThis);

  const rowsPrevMonth = await page.locator('[data-testid="defect-rate-row"]').count();
  expect(rowsPrevMonth).not.toBe(rowsThisMonth);
});

test('quality: 粒度切替で行数が変化 (variation 粒度で行が増える)', async ({ page }) => {
  await page.goto('/quality/defect-rate?period=monthly&granularity=parent', {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('granularity-parent')).toHaveClass(/bg-brand-500/);
  const rowsParent = await page.locator('[data-testid="defect-rate-row"]').count();
  // parent 粒度ではバリエーション列なし
  await expect(page.locator('th', { hasText: 'バリエーション' })).toHaveCount(0);

  // 子バリエーション粒度へ
  await page.getByTestId('granularity-variation').click();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('granularity-variation')).toHaveClass(/bg-brand-500/);
  // variation 粒度ではバリエーション列がある
  await expect(page.locator('th', { hasText: 'バリエーション' })).toHaveCount(1);

  const rowsVariation = await page.locator('[data-testid="defect-rate-row"]').count();
  expect(rowsVariation).toBeGreaterThan(rowsParent);
});

test('quality: ?month=invalid → 今月にクランプ (400 にしない)', async ({ page }) => {
  // MM 範囲外 (00) → 今月にフォールバック
  await page.goto('/quality/defect-rate?period=monthly&month=2026-00&granularity=parent', {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByTestId('current-month')).toBeVisible({ timeout: 15000 });
  const monthShown = await page.getByTestId('current-month').textContent();
  expect(monthShown).toMatch(/^\d{4}-\d{2}$/);
  expect(monthShown).not.toBe('2026-00');
});
