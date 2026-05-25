/**
 * Core ログイン (OIDC リダイレクト方式) E2E
 *
 * cutover (2026-05-25): Third-Party Auth 直方式 (signInWithPassword) → OIDC リダイレクト方式へ書換。
 * ec-manager/factory-management/origintree-logi と同型: cs-manager /login → origin-core 認可画面 →
 * callback で帰還 → tool_access['cs-manager'] ゲート。
 *
 * 実行: E2E_BASE_URL=https://<本番URL> npx playwright test core-login
 *
 * 検証レイヤ:
 *   1. ゲート作動 (creds 不要): 未ログインで保護ページ → /login へリダイレクト。
 *   2. フラグ ON 確認 (creds 不要): /login が「origin-core でログイン」ボタンを描画 (フォームではない)。
 *   3. authorize 遷移 (creds 不要): /api/auth/login → origin-core authorize へ 302
 *      (client_id / redirect_uri / PKCE / state 付き)。
 *   4. tool_access ゲート通過 (要 Core ログイン): 本番は木元アカウント手動ログインで最終確認
 *      (仮 PASS を作らない方針)。
 */
import { test, expect } from '@playwright/test';

const RUN_AGAINST_DEPLOYED = !!process.env.E2E_BASE_URL;

test.describe('Core login (OIDC redirect)', () => {
  test.skip(!RUN_AGAINST_DEPLOYED, 'E2E_BASE_URL 未設定 (flag ON のデプロイ先を指定して実行する)');

  test('未ログインで保護ページにアクセスすると /login へリダイレクトされる', async ({ page }) => {
    await page.goto('/');
    expect(page.url()).toContain('/login');
    expect(page.url()).toContain('redirect=');
  });

  test('フラグ ON のとき /login は origin-core ログインボタンを描画する', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('ユーザーログインは現在無効です')).toHaveCount(0);
    // パスワードフォームは撤去済 (OIDC リダイレクト方式)。
    await expect(page.locator('input[name="password"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'origin-core でログイン' })).toBeVisible();
  });

  test('/api/auth/login は origin-core の authorize へ 302 する', async ({ request }) => {
    const res = await request.get('/api/auth/login?redirect=%2F', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const loc = res.headers()['location'] ?? '';
    expect(loc).toContain('/auth/v1/oauth/authorize');
    expect(loc).toContain('response_type=code');
    expect(loc).toContain('client_id=');
    expect(loc).toContain('code_challenge=');
    expect(loc).toContain('code_challenge_method=S256');
    expect(loc).toContain('redirect_uri=');
    expect(loc).toContain('state=');
  });

  test('/api/auth/callback は state 不一致を 400 で弾く', async ({ request }) => {
    const res = await request.get('/api/auth/callback?code=x&state=bogus', { maxRedirects: 0 });
    expect(res.status()).toBe(400);
  });
});
