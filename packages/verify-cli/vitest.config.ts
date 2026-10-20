import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 引数解析などの純関数を対象にする。DOM 非依存なので node 環境で十分。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 配布物の smoke (#298) は build 済みの dist/cli.js が前提なので通常の test:run から外す。
    // build 後に `npm run test:dist` (vitest.dist.config.ts) で走らせる。
    exclude: [...configDefaults.exclude, 'src/__tests__/distSmoke.test.ts'],
    globals: true,
  },
});
