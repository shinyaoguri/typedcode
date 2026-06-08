import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // mode / storageKeys は純関数 (DOM 非依存) なので node 環境で十分。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
