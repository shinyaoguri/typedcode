import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 既定は node (TrustCalculator 等の純関数)。DOM が要る UI テストはファイル先頭に
    // `// @vitest-environment happy-dom` を書いて個別に切り替える (vitest 5 に environmentMatchGlobs は無い)。
    // 実際の index.html を組み立てる手順は `src/ui/__tests__/verifyDom.ts`。
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
        lines: 23,
        functions: 16,
        branches: 18,
        statements: 22,
      },
    },
  },
});
