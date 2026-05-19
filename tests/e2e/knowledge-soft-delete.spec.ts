/**
 * knowledge_articles ソフト削除 E2E
 *
 * 検証フロー:
 *   1. /knowledge/new でナレッジを作成 → 詳細ページへ遷移
 *   2. 詳細ページで 削除ボタン → confirm dialog accept → /knowledge へリダイレクト
 *   3. 一覧に該当ナレッジが消えていることを確認
 *   4. 件数バッジ (すべて) が削除前より減少していることを確認
 *   5. archived バッジが UI に一切表示されないことを確認
 */
import { test, expect, type Page } from '@playwright/test';

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

/**
 * scope tabs から「すべて」タブ内のカウントバッジ数値を抽出。
 * ScopeTabs は <button><span>すべて</span><span>{count}</span></button> 構造。
 */
async function getAllTabCount(page: Page): Promise<number> {
  const btn = page.locator('button', { hasText: 'すべて' }).first();
  await expect(btn).toBeVisible({ timeout: 15000 });
  const text = (await btn.textContent()) ?? '';
  const m = text.match(/(\d+)/);
  if (!m) throw new Error(`could not extract count from tab text: "${text}"`);
  return parseInt(m[1], 10);
}

test('knowledge: 作成 → 削除 → 一覧から消える + 件数減 + アーカイブUI非表示', async ({ page }) => {
  const buckets = attachCollectors(page);
  const title = `ソフト削除テスト_${Date.now()}`;

  // 0. 一覧で削除前の件数を取得
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'ナレッジ' })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
  const countBefore = await getAllTabCount(page);

  // 1. 新規作成
  await page.goto('/knowledge/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'ナレッジ新規作成' })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');

  await page.locator('input[type="text"]').first().fill(title);

  // submit → 詳細ページへ遷移
  await Promise.all([
    page.waitForURL(/\/knowledge\/[0-9a-f-]+$/, { timeout: 15000 }),
    page.getByRole('button', { name: /^作成$/ }).click(),
  ]);

  // 詳細ページが表示される (タイトル h1 として描画)
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 15000 });

  // 1.5. 一覧で件数が +1 されていることを確認 (作成が確実に効いたことを保証)
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const countAfterCreate = await getAllTabCount(page);
  expect(countAfterCreate).toBe(countBefore + 1);

  // 該当行が一覧に存在すること
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10000 });

  // 2. 一覧 → 該当タイトルのリンクをクリック → 詳細
  await page.getByText(title).first().click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 15000 });

  // 3. 削除ボタン → confirm accept → /knowledge へリダイレクト
  page.once('dialog', (dialog) => dialog.accept());
  await Promise.all([
    page.waitForURL(/\/knowledge(?:$|\?|#)/, { timeout: 15000 }),
    page.getByRole('button', { name: /^削除$/ }).click(),
  ]);

  // 4. 一覧から消えている
  await expect(page.getByRole('heading', { name: 'ナレッジ' })).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(title)).toHaveCount(0);

  // 5. 件数バッジが削除前と同じ (作成→削除で ±0)
  const countAfterDelete = await getAllTabCount(page);
  expect(countAfterDelete).toBe(countBefore);

  // 6. archived バッジ / アーカイブ UI が一切表示されないこと
  await expect(page.locator('text=アーカイブ')).toHaveCount(0);

  // console / network エラー無し
  expect(buckets.consoleErrors).toEqual([]);
  expect(buckets.networkErrors).toEqual([]);
});
