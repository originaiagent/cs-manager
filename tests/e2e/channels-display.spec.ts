/**
 * 段階0a 8 チャネル UI 検証 E2E
 *
 * 目的: channels テーブルに登録された全 channel が cs-manager UI に表示され、
 *       未スタイル登録の code (qoo10/aupay) が ChannelBadge fallback (HelpCircle + neutral gray)
 *       で吸収されていることを自動検証する。
 *
 * チャネル一覧は DB から動的取得 (tests/e2e/_fixtures/channels.ts) — テストにハードコードしない。
 *
 * preview URL は E2E_BASE_URL 環境変数で受け取る (playwright.config.ts 参照)。
 */
import { test, expect, type Page } from '@playwright/test';
import { loadE2EFixtures, type ChannelRow } from './_fixtures/channels';

let CHANNELS: ChannelRow[] = [];
let SAMPLE_TICKET_ID: string | null = null;

test.beforeAll(async () => {
  const f = await loadE2EFixtures();
  CHANNELS = f.channels;
  SAMPLE_TICKET_ID = f.sampleTicketId;
});

interface ErrorBuckets {
  pageErrors: string[];
  networkErrors: { url: string; status: number }[];
}

function attachErrorCollectors(page: Page): ErrorBuckets {
  const pageErrors: string[] = [];
  const networkErrors: { url: string; status: number }[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('response', (resp) => {
    const status = resp.status();
    const url = resp.url();
    if (resp.request().method() !== 'GET') return;
    if (status < 400 || status >= 600) return;
    // Next.js のプリフェッチ・テレメトリ・解析系・favicon 取得失敗は監視対象外
    if (
      url.includes('/_next/data') ||
      url.includes('/favicon') ||
      url.includes('vercel-insights') ||
      url.includes('vitals.vercel-insights') ||
      url.includes('/_vercel/')
    ) return;
    networkErrors.push({ url, status });
  });
  return { pageErrors, networkErrors };
}

test.describe('段階0a: 8 チャネル UI', () => {
  test('(a) /inbox 遷移成功', async ({ page }) => {
    const r = await page.goto('/inbox', { waitUntil: 'domcontentloaded' });
    expect(r?.status() ?? 0, '/inbox HTTP').toBeLessThan(400);
    await expect(page.getByRole('heading', { name: '受信箱' })).toBeVisible({ timeout: 15000 });
  });

  test('(b) /inbox にチャネルフィルタ全 channel が表示', async ({ page }) => {
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '受信箱' })).toBeVisible({ timeout: 15000 });
    for (const ch of CHANNELS) {
      const text = ch.display_name ?? ch.code;
      await expect(page.locator('body'), `inbox に ${ch.code} (${text}) が表示`).toContainText(text);
    }
  });

  test('(c) qoo10/aupay は HelpCircle アイコンで表示 (未登録 code fallback)', async ({ page }) => {
    await page.goto('/knowledge?scope=store', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toContainText('Qoo10', { timeout: 15000 });
    for (const code of ['qoo10', 'aupay']) {
      const ch = CHANNELS.find((c) => c.code === code);
      // ループ内で test.skip() を呼ぶとループ全体が中断するため continue で個別スキップ
      if (!ch) continue;
      // ChannelBadge: <span class="...bg-gray-50..."> 内に lucide-help-circle (or lucide-circle-help) SVG
      const fallbackBadge = page
        .locator('span.bg-gray-50.text-gray-600.border-gray-200', { hasText: ch.display_name })
        .filter({ has: page.locator('svg.lucide-circle-help, svg.lucide-help-circle') });
      await expect(fallbackBadge.first(), `${code} fallback badge with HelpCircle`).toBeVisible({ timeout: 10000 });
    }
  });

  test('(d) qoo10/aupay は neutral gray fallback クラス', async ({ page }) => {
    await page.goto('/knowledge?scope=store', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toContainText('Qoo10', { timeout: 15000 });
    for (const code of ['qoo10', 'aupay']) {
      const ch = CHANNELS.find((c) => c.code === code);
      if (!ch) continue;
      const grayBadge = page.locator(
        'span.bg-gray-50.text-gray-600.border-gray-200',
        { hasText: ch.display_name },
      );
      await expect(grayBadge.first(), `${code} neutral gray badge`).toBeVisible({ timeout: 10000 });
    }
  });

  test('(e) /knowledge に全 channel が表示', async ({ page }) => {
    await page.goto('/knowledge?scope=store', { waitUntil: 'domcontentloaded' });
    for (const ch of CHANNELS) {
      const text = ch.display_name ?? ch.code;
      await expect(page.locator('body'), `knowledge に ${ch.code} (${text}) が表示`).toContainText(text);
    }
    await page.screenshot({ path: 'tests/e2e/screenshots/knowledge.png', fullPage: true });
  });

  test('(f) /tickets/[id] でチャネルバッジが表示', async ({ page }) => {
    test.skip(!SAMPLE_TICKET_ID, 'tickets が 0 件のため /tickets/[id] スキップ');
    const r = await page.goto(`/tickets/${SAMPLE_TICKET_ID}`, { waitUntil: 'domcontentloaded' });
    expect(r?.status() ?? 0, '/tickets/[id] HTTP').toBeLessThan(500);
    // チケット詳細でも ChannelBadge が描画されている (size='md', rakuten想定)
    const anyBadge = page.locator('span.inline-flex.items-center.rounded-full.border').first();
    await expect(anyBadge, 'チケット詳細にチャネルバッジ').toBeVisible({ timeout: 10000 });
  });

  test('(g) rakuten チャネルフィルタで非破壊 (空状態でも OK)', async ({ page }) => {
    const r = await page.goto('/inbox?channel=rakuten', { waitUntil: 'domcontentloaded' });
    expect(r?.status() ?? 0, '/inbox?channel=rakuten HTTP').toBeLessThan(400);
    await expect(page.getByRole('heading', { name: '受信箱' })).toBeVisible({ timeout: 15000 });
  });

  test('(h)(i) コンソールエラー / GET 4xx-5xx ネットワーク 0 件', async ({ page }) => {
    const buckets = attachErrorCollectors(page);
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '受信箱' })).toBeVisible({ timeout: 15000 });
    await page.goto('/knowledge?scope=store', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000); // 遅延読み込みの 4xx を拾う猶予
    expect(buckets.pageErrors, 'console pageerror').toEqual([]);
    expect(buckets.networkErrors, 'GET 4xx/5xx network errors').toEqual([]);
  });

  test('(z) スクリーンショット保存', async ({ page }) => {
    await page.goto('/inbox', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '受信箱' })).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: 'tests/e2e/screenshots/inbox.png', fullPage: true });
    await page.goto('/inbox?channel=rakuten', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '受信箱' })).toBeVisible();
    await page.screenshot({ path: 'tests/e2e/screenshots/inbox-rakuten-filter.png', fullPage: true });
  });
});
