/**
 * 配布物 `dist/cli.js` の smoke test (#298)。`npm run test:dist` 専用 (build 後に走らせる)。
 *
 * tsc の出力は `@typedcode/shared` (raw TypeScript) の解決で ERR_MODULE_NOT_FOUND になり、
 * README どおり `node dist/cli.js` を叩くと即死していた。tsx で `src/cli.ts` を起動する
 * 開発用テスト (cliExitProcess.test.ts / e2e) では再現しないので、配布物は別にここで見る。
 *
 * - **素の node** で起動する (tsx / ts-node の暗黙の前提を持たせない)
 * - `dist/` だけをリポジトリ外の一時ディレクトリへ写して起動する。モノレポの node_modules や
 *   shared のソースに解決が落ちて「たまたま動く」のを防ぐ (`files: ["dist"]` が配布物の全部)
 * - `dist/cli.js` が無いときは skip ではなく fail させる (build 忘れで素通りさせない)
 *
 * 通常の `test:run` からは外してある (vitest.config.ts の exclude)。build 済みでない
 * 開発環境で全体のテストを壊さないため。CI は build の後に `test:dist` を回す。
 */

import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { DIST_ENTRY, fixture, writeBrokenProof } from './helpers/runCli.js';

let isolatedCli: string;

function runIsolated(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [isolatedCli, ...args], {
    // cwd も一時ディレクトリにして、相対解決がリポジトリへ落ちないようにする
    cwd: resolve(isolatedCli, '../..'),
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { exitCode: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeAll(() => {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(`${DIST_ENTRY} がありません。先に \`npm run build -w @typedcode/verify-cli\` を実行してください`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'tc-verify-cli-dist-'));
  cpSync(resolve(DIST_ENTRY, '..'), join(dir, 'dist'), { recursive: true });
  isolatedCli = join(dir, 'dist', 'cli.js');
});

describe('dist/cli.js on plain Node (#298)', () => {
  it('--help exits 0', () => {
    const res = runIsolated(['--help']);
    expect(res.exitCode).toBe(0);
  });

  it('a valid proof passes with exit 0', () => {
    const res = runIsolated([fixture('proofs', 'valid.json')]);
    expect(res.exitCode).toBe(0);
  });

  it('a proof that fails verification exits 1', () => {
    const res = runIsolated([fixture('proofs', 'tampered.json')]);
    expect(res.exitCode).toBe(1);
  });

  it('an unparseable proof exits 1', () => {
    const res = runIsolated([writeBrokenProof()]);
    expect(res.exitCode).toBe(1);
  });

  it('an external --analyzer module is still loaded by dynamic import from the bundle', () => {
    const res = runIsolated(['--analyzer', fixture('analyzers', 'valid-default.mjs'), fixture('proofs', 'valid.json')]);
    expect(res.stdout).toContain('fixture-default@1.0.0');
  });

  it('the bundle carries no import of raw .ts sources, tsx or ts-node', () => {
    const source = readFileSync(isolatedCli, 'utf-8');
    const offending =
      source.match(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:\.ts|\btsx|ts-node)['"]/g) ?? [];
    expect(offending).toEqual([]);
  });
});
