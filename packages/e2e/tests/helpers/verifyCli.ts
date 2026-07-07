import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const CLI_ENTRY = resolve(REPO_ROOT, 'packages/verify-cli/src/cli.ts');
// tsx の設置場所 (root hoist か packages/e2e 配下か) は lockfile 再生成で変わりうるため、
// root の node_modules/.bin を決め打ちせず Node の解決機構で引く
// (Dependabot の lockfile 更新で root hoist が外れ spawn ENOENT になった実績: PR #189)。
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/**
 * verify-cli を実プロセスとして起動して proof を検証する。
 *
 * shared の main は raw TypeScript (`src/index.ts`) なので `node dist/cli.js` は
 * ERR_MODULE_NOT_FOUND になる (verify-cli/CLAUDE.md の既知課題)。E2E では
 * tsx で `src/cli.ts` を直接実行し、CLI の引数解析・ZIP 展開・exit code・
 * shared 統合まで「本物の CLI 表面」を検証する。
 */
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** verification 成功 = exit 0 */
  passed: boolean;
}

export interface CliAnalysisEntry {
  filename: string;
  valid: boolean;
  analysis: {
    reviewPriority?: number;
    findings?: Array<{ analyzerId: string; severity: string; summary: string }>;
    [k: string]: unknown;
  };
}

export interface CliResultWithAnalysis extends CliResult {
  /** --analysis-json の中身 (proof ごとの配列)。advisory なので exit code とは独立。 */
  analysis: CliAnalysisEntry[];
}

export function runVerifyCli(file: string, extraArgs: string[] = []): CliResult {
  const res = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, file, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    // full PoSW 再計算 (10,000 iter/event) は遅い CI ランナー (2 コア・他プロセスと競合) で
    // 数分かかりうる。ローカルの数倍を見込んで余裕を取る。
    timeout: 240_000,
  });
  if (res.error) {
    throw new Error(`verify-cli failed to spawn: ${res.error.message}`);
  }
  const exitCode = res.status ?? -1;
  return {
    exitCode,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    passed: exitCode === 0,
  };
}

/**
 * proof を検証しつつ advisory analysis レポートも取得する。
 * 機能検証では「チェーンが valid か」と「分析シグナルが期待通り出ているか」を
 * 独立に assert したいので両方返す。
 */
export function runVerifyCliWithAnalysis(file: string, extraArgs: string[] = []): CliResultWithAnalysis {
  const outDir = mkdtempSync(join(tmpdir(), 'tc-e2e-analysis-'));
  const analysisPath = join(outDir, 'analysis.json');
  const res = runVerifyCli(file, [...extraArgs, '--analysis-json', analysisPath]);
  let analysis: CliAnalysisEntry[] = [];
  if (existsSync(analysisPath)) {
    analysis = JSON.parse(readFileSync(analysisPath, 'utf-8')) as CliAnalysisEntry[];
  }
  return { ...res, analysis };
}
