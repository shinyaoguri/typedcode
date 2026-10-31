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
    // カバレッジは `npm run test:coverage` で計測する (ADR-0034)。thresholds は実測値を切り捨てた床で、
    // 下回ると CI (test job) が落ちる。上げたら `npm run coverage:ratchet` (ルート) で床を引き上げる。
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // cli.ts は import しただけで process を操作するエントリ (E2E / test:dist が担う)
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.d.ts', 'src/cli.ts'],
      thresholds: {
        // 普段のテストで config が書き換わらないよう、ラチェット時 (COVERAGE_RATCHET=1) だけ有効にする
        autoUpdate: process.env.COVERAGE_RATCHET === '1' ? (value: number) => Math.floor(value) : false,
        lines: 74,
        functions: 73,
        branches: 61,
        statements: 74,
      },
    },
  },
});
