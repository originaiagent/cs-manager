/**
 * customer_service_records (対応記録) E2E
 *
 * 検証フロー:
 *   1. /customer-records 一覧ページがエラー無しで描画される
 *   2. /customer-records/new でフォーム入力 → submit → 一覧に行が追加されている
 *   3. 該当行の編集リンク → /customer-records/[id] で値が prefill されている
 *   4. メモを更新 → 一覧でメモが変わっている
 *   5. 編集ページで削除 → 一覧から消えている
 *
 *   ticket 連携:
 *     - /customer-records/new?ticket_id=<uuid> 形式の URL でフォームに ticket_id が hidden で渡る
 *     - (ticket 詳細ページからの「対応記録に追加」ボタン UI は別 PR 範囲)
 */
import { test, expect, type Page } from '@playwright/test';
import { loadE2EFixtures } from './_fixtures/channels';

let SAMPLE_TICKET_ID: string | null = null;

test.beforeAll(async () => {
  const f = await loadE2EFixtures();
  SAMPLE_TICKET_ID = f.sampleTicketId;
});

function attachCollectors(page: Page) {
  const consoleErrors: string[] = [];
  const networkErrors: { url: string; status: number }[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('response', (resp) => {
    if (resp.request().method() !== 'GET') return;
    const s = resp.status();
    if (
      s >= 400 &&
      s < 600 &&
      !resp.url().includes('/_next/') &&
      !resp.url().includes('favicon')
    ) {
      networkErrors.push({ url: resp.url(), status: s });
    }
  });
  return { consoleErrors, networkErrors };
}

test('customer-records: 一覧ページが描画される (console/network エラー無し)', async ({ page }) => {
  const buckets = attachCollectors(page);
  await page.goto('/customer-records', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /対応記録一覧/ })).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(500);
  expect(buckets.consoleErrors).toEqual([]);
  expect(buckets.networkErrors).toEqual([]);
});

test('customer-records: 作成 → 編集 → 削除の 1 サイクル smoke', async ({ page }) => {
  const productName = `テスト商品_${Date.now()}`;
  const recipient = 'テスト太郎';
  const initialMemo = '初期メモ';
  const updatedMemo = '更新後メモ';

  // 1. /customer-records/new
  await page.goto('/customer-records/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /対応記録 新規登録/ })).toBeVisible({ timeout: 15000 });

  // React hydration を確実に待つ (controlled input が動くまで)
  await page.waitForLoadState('networkidle');

  // ProductPicker (PR-EF): 手入力モードに切替 → 商品名入力
  await page.getByRole('button', { name: /手入力モードに切替/ }).click();
  await page.locator('input[name="product_name_text"]').fill(productName);
  await page.locator('input[name="recipient_name"]').fill(recipient);
  await page.locator('select[name="action_type"]').selectOption('reply_only');
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await page.locator('input[name="record_date"]').fill(ymd);
  await page.locator('textarea[name="memo"]').fill(initialMemo);

  await Promise.all([
    page.waitForURL(/\/customer-records(?:$|\?)/, { timeout: 15000 }),
    page.getByRole('button', { name: /^作成$/ }).click(),
  ]);

  // 2. 一覧で該当行を探す → 編集リンクをクリック
  await expect(page.getByRole('heading', { name: /対応記録一覧/ })).toBeVisible({ timeout: 15000 });
  const row = page.locator('tr', { hasText: productName }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row).toContainText(initialMemo);
  await expect(row).toContainText(recipient);

  await row.getByRole('link', { name: /編集/ }).click();
  await expect(page.getByRole('heading', { name: /対応記録 編集/ })).toBeVisible({ timeout: 15000 });

  // 3. prefill 検証 + メモ更新
  await page.waitForLoadState('networkidle');
  await expect(page.locator('input[name="product_name_text"]')).toHaveValue(productName);
  await expect(page.locator('input[name="recipient_name"]')).toHaveValue(recipient);
  await expect(page.locator('textarea[name="memo"]')).toHaveValue(initialMemo);

  await page.locator('textarea[name="memo"]').fill(updatedMemo);
  await Promise.all([
    page.waitForURL(/\/customer-records(?:$|\?)/, { timeout: 15000 }),
    page.getByRole('button', { name: /^保存$/ }).click(),
  ]);

  // 4. 一覧で更新確認
  const updatedRow = page.locator('tr', { hasText: productName }).first();
  await expect(updatedRow).toBeVisible({ timeout: 10000 });
  await expect(updatedRow).toContainText(updatedMemo);

  // 5. 編集ページ → 削除
  await updatedRow.getByRole('link', { name: /編集/ }).click();
  await expect(page.getByRole('heading', { name: /対応記録 編集/ })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');

  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([
    page.waitForURL(/\/customer-records(?:$|\?)/, { timeout: 15000 }),
    page.getByRole('button', { name: /^削除$/ }).click(),
  ]);

  // 6. 一覧から消えている
  await expect(page.locator('tr', { hasText: productName })).toHaveCount(0);
});

test('customer-records: /new?ticket_id=<uuid> で ticket_id が hidden 値として渡る', async ({ page }) => {
  test.skip(!SAMPLE_TICKET_ID, 'tickets が 0 件のためスキップ');
  await page.goto(`/customer-records/new?ticket_id=${SAMPLE_TICKET_ID}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('heading', { name: /対応記録 新規登録/ })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/関連チケット/)).toBeVisible({ timeout: 10000 });
  const hidden = page.locator('[data-testid="ticket-id-hidden"]');
  await expect(hidden).toHaveValue(SAMPLE_TICKET_ID!);
});
