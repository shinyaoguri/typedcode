import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // mode / storageKeys は純関数 (DOM 非依存) なので node 環境で十分。
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    // カバレッジは `npm run test:coverage` で計測する (ADR-0034)。thresholds は実測値を切り捨てた床で、
    // 下回ると CI (test job) が落ちる。上げたら `npm run coverage:ratchet` (ルート) で床を引き上げる。
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // main.ts は DOM を組み立てて起動するだけのエントリ (E2E が担う)
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.d.ts', 'src/main.ts'],
      thresholds: {
        // 普段のテストで config が書き換わらないよう、ラチェット時 (COVERAGE_RATCHET=1) だけ有効にする
        autoUpdate: process.env.COVERAGE_RATCHET === '1' ? (value: number) => Math.floor(value) : false,
        lines: 8,
        functions: 6,
        branches: 8,
        statements: 8,
      },
    },
  },
});
