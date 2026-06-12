import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['src/lib/mcp/__contract__/**/*.test.ts', 'tests/vitest/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // cs-manager の tsconfig は @/* → ./src/* (および ./*) を解決する。
      // MCP lib は src/lib/mcp 配下なので @ → ./src で十分。
      '@': path.resolve(__dirname, './src'),
    },
  },
});
