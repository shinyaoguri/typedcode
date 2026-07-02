import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 引数解析などの純関数を対象にする。DOM 非依存なので node 環境で十分。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
