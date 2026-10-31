import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    globals: true,
    // カバレッジは `npm run test:coverage` で計測する (ADR-0034)。thresholds は実測値を切り捨てた床で、
    // 下回ると CI (test job) が落ちる。上げたら `npm run coverage:ratchet` (ルート) で床を引き上げる。
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // index.ts は re-export だけのバレル
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.d.ts', 'src/index.ts'],
      thresholds: {
        // 普段のテストで config が書き換わらないよう、ラチェット時 (COVERAGE_RATCHET=1) だけ有効にする
        autoUpdate: process.env.COVERAGE_RATCHET === '1' ? (value: number) => Math.floor(value) : false,
        lines: 74,
        functions: 69,
        branches: 68,
        statements: 73,
      },
    },
  },
});
