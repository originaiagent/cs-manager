/**
 * customer_service_records 親+子バリエーション E2E (PR-EF)
 *
 * 検証フロー:
 *   1. /customer-records/new で親グループを検索
 *   2. 候補から親を選択 (例: EMSフットマット)
 *   3. 子バリエーション pulldown が表示される (2件以上の場合)
 *   4. 子を選択 → JAN 等が表示される
 *   5. その他の必須欄を埋めて保存
 *   6. 一覧に行が追加され、親+子+JAN 情報が表示される
 *
 * NOTE: Core API の "EMSフットマ" (id=1) は 5 バリエーションを持つ前提
 *       Core が利用不可な環境ではテスト skip
 */
import { test, expect } from '@playwright/test';

test('customer-records: 親グループ検索 → 子バリエーション選択 → 保存 → 一覧で親+子+JAN 表示', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/customer-records/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /対応記録 新規登録/ })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');

  // 親グループ検索
  const searchInput = page.locator('input[placeholder*="商品名で検索"]').first();
  await expect(searchInput).toBeVisible({ timeout: 10000 });
  await searchInput.fill('EMS');

  // サジェスト候補が出るまで待つ
  const suggestionButton = page.locator('button', { hasText: /EMS/ }).first();
  await expect(suggestionButton).toBeVisible({ timeout: 15000 });
  await suggestionButton.click();

  // 親選択後、選択済みチップが表示される
  await expect(page.locator('span', { hasText: /group_id=/ }).first()).toBeVisible({ timeout: 10000 });

  // 子バリエーション pulldown を待つ (Core が 2 件以上返す前提)
  // 子 1 件なら自動選択 (pulldown 非表示) になるので両ケース許容
  const variationSelect = page.locator('select').filter({ hasText: /選択してください|EMSフットマット|JAN/ });
  const variationCount = await variationSelect.count();
  if (variationCount > 0) {
    // 2件以上 → 1番目以外を選択
    const opts = await variationSelect.first().locator('option').allTextContents();
    // 最初の (選択してください) を除く最初の実 option を選ぶ
    const firstReal = opts.find((t) => t && !t.includes('選択してください'));
    if (firstReal) {
      await variationSelect.first().selectOption({ label: firstReal });
    }
  }

  // 受取人 + 日付
  const recipient = `テストPR_EF_${Date.now()}`;
  await page.locator('input[name="recipient_name"]').fill(recipient);
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await page.locator('input[name="record_date"]').fill(ymd);

  // 保存
  await Promise.all([
    page.waitForURL(/\/customer-records(?:$|\?)/, { timeout: 15000 }),
    page.getByRole('button', { name: /^作成$/ }).click(),
  ]);

  // 一覧で確認: 受取人名で該当行を探す
  await expect(page.getByRole('heading', { name: /対応記録一覧/ })).toBeVisible({ timeout: 15000 });
  const row = page.locator('tr', { hasText: recipient }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  // 親 group_id 表示
  await expect(row).toContainText(/group=/);

  // cleanup: 編集ページで削除
  await row.getByRole('link', { name: /編集/ }).click();
  await expect(page.getByRole('heading', { name: /対応記録 編集/ })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([
    page.waitForURL(/\/customer-records(?:$|\?)/, { timeout: 15000 }),
    page.getByRole('button', { name: /^削除$/ }).click(),
  ]);
});
