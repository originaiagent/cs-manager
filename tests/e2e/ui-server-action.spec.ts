/**
 * UI → Server Action → /api/* ラウンドトリップ smoke (DOM/console 健全性)
 *
 * Server Action 経由でブラウザ UI がコンソールエラー・ネットワーク 4xx/5xx を出さずに
 * 描画されることを確認する。Server Action 内部 fetch が認証エラーになると
 * クライアント側の動作が壊れる (alert/Error) 経路を検出するための fail-safe。
 *
 * Server Action ↔ /api/* の認証通過自体は api-auth.spec.ts F で end-to-end (POST→DELETE) 検証済み。
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

test('UI 健全性: /knowledge がコンソール/ネットワーク エラーなしで描画される', async ({ page }) => {
  const buckets = attachCollectors(page);
  await page.goto('/knowledge', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /ナレッジ/ })).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);
  expect(buckets.consoleErrors).toEqual([]);
  expect(buckets.networkErrors).toEqual([]);
});

test('UI 健全性: /tickets/[id] がコンソール/ネットワーク エラーなしで描画される', async ({ page }) => {
  test.skip(!SAMPLE_TICKET_ID, 'tickets が 0 件のためスキップ');
  const buckets = attachCollectors(page);
  await page.goto(`/tickets/${SAMPLE_TICKET_ID}`, { waitUntil: 'domcontentloaded' });
  // StatusControls 描画完了の indicator
  await expect(
    page.locator('div.inline-flex.rounded-lg.border.border-gray-200.bg-white').first(),
  ).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(800);
  expect(buckets.consoleErrors).toEqual([]);
  expect(buckets.networkErrors).toEqual([]);
});

test('UI 健全性: /quality がコンソール/ネットワーク エラーなしで描画される', async ({ page }) => {
  const buckets = attachCollectors(page);
  await page.goto('/quality/improvement-suggestions', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  expect(buckets.consoleErrors).toEqual([]);
  expect(buckets.networkErrors).toEqual([]);
});
