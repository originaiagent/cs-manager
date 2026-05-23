/**
 * Core ログイン (Third-Party Auth / JWKS) E2E
 *
 * ステータス: BLOCKED — まだ実行できない。
 *
 * 前提となる手動作業 (未完了):
 *   1. cs-manager 側 Supabase (jpnsoqzzylahpandbfcz) ダッシュボードで
 *      origin-core を Third-Party Auth (JWKS) provider として登録する。
 *   2. Vercel に NEXT_PUBLIC_CORE_SUPABASE_URL / _ANON_KEY を設定。
 *   3. NEXT_PUBLIC_CORE_AUTH_ENABLED=true で再デプロイ (カットオーバー)。
 *
 * 上記が揃うまで本テストは実行不能。仮 PASS を作らない方針のため test.fixme で保留する。
 * 揃ったら fixme を外し、実アカウントでログイン→保護ページ到達→ロール不足拒否を検証する。
 */
import { test, expect } from '@playwright/test';

test.describe('Core login (Third-Party Auth)', () => {
  test.fixme(
    'authenticated cs_manager user can reach protected pages, others are redirected',
    async ({ page }) => {
      // BLOCKED: JWKS provider not yet registered in jpnsoqzzylahpandbfcz
      // and NEXT_PUBLIC_CORE_AUTH_ENABLED is OFF. Do not fake a pass.

      // 想定フロー (provider 登録 + フラグ ON 後に実装):
      //   1. 未ログインで / にアクセス → /login?redirect=%2F へリダイレクト
      //   2. Core アカウント (cs_manager ロール保有) でログイン → redirect 先へ
      //   3. cs_manager ロール無しアカウント → /login?error=forbidden
      await page.goto('/');
      expect(page.url()).toContain('/login');
    },
  );
});
