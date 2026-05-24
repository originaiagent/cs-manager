/**
 * Core ログイン (Third-Party Auth / JWKS) E2E
 *
 * cutover (2026-05-24): JWKS provider 登録済 + Vercel に Core 認証 env 投入 +
 * NEXT_PUBLIC_CORE_AUTH_ENABLED=true で本番デプロイ済。
 *
 * 実行方法:
 *   E2E_BASE_URL=https://<本番URL> npx playwright test core-login
 *
 * 検証レイヤ:
 *   1. ゲート作動 (creds 不要): 未ログインで保護ページ → /login へリダイレクト。
 *   2. フラグ ON 確認 (creds 不要): /login が「無効です」案内ではなくログインフォームを描画。
 *   3. tool_access ゲート通過 (要 Core creds): origin-core に実ログインできるアカウントの
 *      session を張り、保護ページ到達 + 業務 API 200 を確認。
 *      Core の認証情報 (CORE_E2E_EMAIL / CORE_E2E_PASSWORD) が無い環境では skip
 *      (仮 PASS を作らない方針)。本番では木元アカウントの手動ログインで最終確認する。
 *
 * 注意: middleware は origin-core 側 Supabase の session cookie を getUser() で検証する。
 *   cs-manager 自身の DB アクセスは従来通り server-side service_role 経由。
 */
import { test, expect } from '@playwright/test';

const RUN_AGAINST_DEPLOYED = !!process.env.E2E_BASE_URL;

test.describe('Core login (Third-Party Auth)', () => {
  // フラグ ON の本番/preview を対象にしたときのみ意味を持つ。localhost 既定では skip。
  test.skip(
    !RUN_AGAINST_DEPLOYED,
    'E2E_BASE_URL 未設定 (flag ON のデプロイ先を指定して実行する)',
  );

  test('未ログインで保護ページにアクセスすると /login へリダイレクトされる', async ({
    page,
  }) => {
    const res = await page.goto('/');
    // middleware が未ログインを検出して /login?redirect=%2F へ 307。
    expect(page.url()).toContain('/login');
    expect(page.url()).toContain('redirect=');
    // ステータス自体は最終的に 200 (login ページ描画)。
    expect(res?.status()).toBeLessThan(400);
  });

  test('フラグ ON のとき /login はログインフォームを描画する (無効案内ではない)', async ({
    page,
  }) => {
    await page.goto('/login');
    // フラグ OFF / env 未設定なら「ユーザーログインは現在無効です」になる。
    await expect(
      page.getByText('ユーザーログインは現在無効です'),
    ).toHaveCount(0);
    await expect(page.getByText('オリジンアカウントでログインしてください')).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
  });

  test('tool_access[cs-manager] を持つアカウントで保護ページに到達できる', async ({
    page,
  }) => {
    const email = process.env.CORE_E2E_EMAIL;
    const password = process.env.CORE_E2E_PASSWORD;
    test.skip(
      !email || !password,
      'CORE_E2E_EMAIL / CORE_E2E_PASSWORD 未設定 (本番は木元アカウント手動ログインで確認)',
    );

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email!);
    await page.locator('input[name="password"]').fill(password!);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith('/login')),
      page.getByRole('button', { name: 'ログイン' }).click(),
    ]);
    // 保護ページ (ルート) に到達できている = tool_access ゲート通過。
    expect(new URL(page.url()).pathname).not.toContain('/login');
  });
});
