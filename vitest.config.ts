import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom', // WP8: 组件测试需 DOM (纯逻辑测试兼容 jsdom)
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']
  },
  esbuild: {
    jsx: 'automatic'
  }
});
