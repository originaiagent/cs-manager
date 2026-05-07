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

const baseURL = process.env.E2E_BASE_URL ?? 'https://cs-manager-q1pm87jpd-origin-trees-projects.vercel.app';

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
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
