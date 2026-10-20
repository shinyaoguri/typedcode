/**
 * verify-cli を子プロセスとして起動するテスト用ヘルパ。
 *
 * 終了コードは「プロセスがどう終わったか」で決まる (`process.exitCode` + 自然終了, #283) ので、
 * `main()` を同一プロセスで呼ぶテストでは確かめられない。ここでは実プロセスを立てて
 * exit code と stdout/stderr をそのまま返す。
 *
 * - `runSourceCli`: `src/cli.ts` を tsx で直接起動する (build 不要。通常の test:run 用)
 * - `runDistCli`: build 済みの `dist/cli.js` を**素の node** で起動する (#298 の配布物 smoke 用)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '../../..');
export const SOURCE_ENTRY = resolve(PACKAGE_ROOT, 'src/cli.ts');
export const DIST_ENTRY = resolve(PACKAGE_ROOT, 'dist/cli.js');
export const FIXTURES = resolve(PACKAGE_ROOT, 'src/__tests__/fixtures');

// tsx は verify-cli の依存ではなく root に hoist されたもの (e2e の devDependency) を Node の
// 解決機構で引く。設置場所を決め打ちしない理由は e2e の helpers/verifyCli.ts と同じ (PR #189)。
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

export interface CliRun {
  /** シグナルで落ちた・タイムアウトした場合は null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function run(argv: string[]): CliRun {
  const res = spawnSync(process.execPath, argv, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf-8',
    // full PoSW 再計算は 1 event 分なので一瞬だが、CI の遅いランナーを見込んで余裕を取る。
    // 自然終了しないまま (ハンドルが残る等) 走り続けたら null で返して assert で落とす。
    timeout: 60_000,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
    throw new Error(`verify-cli failed to spawn: ${res.error.message}`);
  }
  return { exitCode: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function runSourceCli(args: string[]): CliRun {
  return run([TSX_CLI, SOURCE_ENTRY, ...args]);
}

export function runDistCli(args: string[]): CliRun {
  return run([DIST_ENTRY, ...args]);
}

export function fixture(...segments: string[]): string {
  return join(FIXTURES, ...segments);
}

/**
 * JSON として壊れた proof を一時ファイルに書いて返す。
 * リポジトリに置くと Biome (`npm run lint`) が JSON の構文エラーで落ちるので、実行時に作る。
 */
export function writeBrokenProof(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-verify-cli-'));
  const path = join(dir, 'broken_proof.json');
  writeFileSync(path, '{"proof":', 'utf-8');
  return path;
}
