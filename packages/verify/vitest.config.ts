import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // TrustCalculator 等の純関数を対象にする (DOM 非依存)。UI コンポーネントのテストを
    // 足すときは happy-dom を導入して environmentMatchGlobs で分けること。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
