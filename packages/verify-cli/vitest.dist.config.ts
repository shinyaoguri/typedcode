import { defineConfig } from 'vitest/config';

// 配布物 (dist/cli.js) の smoke test 専用 (#298)。build 後に `npm run test:dist` で走らせる。
// 通常の test:run (vitest.config.ts) からは除外してあるので、build していない環境でも壊れない。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/distSmoke.test.ts'],
    globals: true,
  },
});
