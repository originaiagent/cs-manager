import { defineConfig, devices } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// .env.local を最小パーサーで読み込む(dotenv 依存追加を避ける)
const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, k, vRaw] = m;
    if (process.env[k] !== undefined) continue;
    let v = vRaw.trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.endsWith('\\n')) v = v.slice(0, -2);
    process.env[k] = v;
  }
}

// env 必須化(ハードコード回避)。preview URL を取り違えてリグレッションを見逃すのを防ぐため、
// 未設定時はローカル dev server を既定にし、CI/preview テスト時は明示的に E2E_BASE_URL を指定する運用。
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    // Unit テスト (browser 不使用)。Playwright test runner を流用してユニットテストを書く。
    {
      name: 'unit',
      testDir: './tests/unit',
      use: {},
    },
    {
      name: 'chromium',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
