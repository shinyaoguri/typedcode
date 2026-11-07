import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const CLI_ENTRY = resolve(REPO_ROOT, 'packages/verify-cli/src/cli.ts');
// tsx の設置場所 (root hoist か packages/e2e 配下か) は lockfile 再生成で変わりうるため、
// root の node_modules/.bin を決め打ちせず Node の解決機構で引く
// (Dependabot の lockfile 更新で root hoist が外れ spawn ENOENT になった実績: PR #189)。
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
// exam の出題者鍵を E2E 用の公開鍵に差し替える resolve フックの登録 (#229)。
// shared の localKeys.ts (開発者の鍵置き場。gitignore 済み) を書き換えずに、使い捨ての鍵を信頼させるための仕組み。
const EXAM_KEYS_REGISTER = pathToFileURL(resolve(HERE, '../../exam-keys/node-register.mjs')).href;

/**
 * verify-cli を実プロセスとして起動して proof を検証する。
 *
 * E2E では build を待たずに済むよう tsx で `src/cli.ts` を直接実行し、CLI の
 * 引数解析・ZIP 展開・exit code・shared 統合まで「本物の CLI 表面」を検証する。
 * 配布物の `dist/cli.js` (esbuild の単一 bundle, #298) を素の node で起動できることは
 * verify-cli 側の smoke (`npm run test:dist -w @typedcode/verify-cli`) が別に担保する。
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
    /** 分析器が立てた signal (shared の `AnalysisSignal`)。`analyzerId` は分析器の id ('automation' など) */
    signals?: Array<{ analyzerId: string; severity: string; summary: string }>;
    [k: string]: unknown;
  };
}

export interface CliResultWithAnalysis extends CliResult {
  /** --analysis-json の中身 (proof ごとの配列)。advisory なので exit code とは独立。 */
  analysis: CliAnalysisEntry[];
}

/**
 * `--result-json` の 1 要素 (verify-cli の `ResultJsonEntry`)。stdout の文言ではなく、これを assert する (#588)。
 * `failedCheck` は最初に落ちた層 (valid なら null)。優先順位は verify-cli の `resultJson.ts` が正本。
 */
export type CliFailedCheck =
  | 'unreadable'
  | 'version'
  | 'metadata'
  | 'root'
  | 'chain'
  | 'content'
  | 'finalHash'
  | 'checkpoint'
  | 'rootAnchor'
  | 'sessionToken'
  | 'policy'
  | 'other';

export interface CliResultEntry {
  filename: string;
  valid: boolean;
  integrityValid: boolean;
  failedCheck: CliFailedCheck | null;
  errorMessage: string | null;
  rootAnchored: boolean;
  temporal: string | null;
  policyViolations: string[];
}

export interface CliResultWithResult extends CliResult {
  /** --result-json の中身 (入力ごと・proof ごとの配列)。advisory なので exit code とは独立。 */
  results: CliResultEntry[];
}

export interface RunVerifyCliOptions {
  /**
   * exam の出題者鍵を E2E 用の公開鍵 (fixtures/exam/authority-keys.mjs) に差し替えて起動する (#229)。
   * `--exam-package` に E2E の fixture を渡すときだけ true にする。他の検証は本物の registry のまま走らせる。
   */
  examAuthorityKeys?: boolean;
}

export function runVerifyCli(file: string, extraArgs: string[] = [], options: RunVerifyCliOptions = {}): CliResult {
  const nodeArgs = options.examAuthorityKeys ? ['--import', EXAM_KEYS_REGISTER] : [];
  const res = spawnSync(process.execPath, [TSX_CLI, ...nodeArgs, CLI_ENTRY, file, ...extraArgs], {
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

/**
 * proof を検証しつつ、検証の結論 (`valid` と、落ちたなら `failedCheck`) を `--result-json` から取得する (#588)。
 * 「exit 1 になった」だけでなく「どの検査で落ちたか」まで assert したいときに使う。
 */
export function runVerifyCliWithResult(
  file: string,
  extraArgs: string[] = [],
  options: RunVerifyCliOptions = {}
): CliResultWithResult {
  const outDir = mkdtempSync(join(tmpdir(), 'tc-e2e-result-'));
  const resultPath = join(outDir, 'result.json');
  const res = runVerifyCli(file, [...extraArgs, '--result-json', resultPath], options);
  if (!existsSync(resultPath)) {
    throw new Error(`verify-cli wrote no result (exit ${res.exitCode})\n${res.stdout}${res.stderr}`);
  }
  return { ...res, results: JSON.parse(readFileSync(resultPath, 'utf-8')) as CliResultEntry[] };
}

/** 1 件以上の入力がすべて valid で、落ちた層が無い (`failedCheck` が null)。0 件は false (何も検証されていない) */
export function allPassed(results: readonly CliResultEntry[]): boolean {
  return results.length > 0 && results.every((r) => r.valid && r.failedCheck === null);
}

/** `--analysis-bundle` 1 件 (Tier A バンドル, ADR-0024) のうち E2E が読む部分。 */
export interface CliVerdictEntry {
  /** ZIP 内のエントリパス (JSON 単体入力ならコマンドに渡したパス)。 */
  filename: string;
  /** exit code の根拠になる proof ごとの合否 (`--analysis-json` の `valid`)。 */
  valid: boolean;
  /** shared の `deriveAssurance` の結果 (verify Web の `#assurance-strip` と同じ導出)。 */
  assurance: {
    integrity: string;
    temporal: string;
    provenance: { pureTyping: boolean; [k: string]: unknown };
  };
  /** `--result-json` の `failedCheck` (valid なら null)。proof ごとに最初に落ちた層 */
  failedCheck: CliFailedCheck | null;
  /** `--analysis-bundle` の `processSummary` のうち E2E が数えるもの (Activity 行の元の値) */
  processSummary: { externalInputCount: number; focusLossCount: number; [k: string]: unknown };
}

export interface CliResultWithVerdicts extends CliResult {
  verdicts: CliVerdictEntry[];
}

/**
 * proof を検証し、proof ごとの機械可読な判定 (合否 + 三層保証) を返す。verify Web の
 * data-* 状態契約と突き合わせる (Web↔CLI パリティ) ための入口。
 *
 * 合否は `--analysis-json` の `valid`、三層保証は `--analysis-bundle` の `assurance` から読む。
 * どちらも advisory 出力で exit code には干渉しない (exit code は `exitCode` で別に見る)。
 * `options` は `runVerifyCli` と同じ (exam の fixture を `--exam-package` に渡すときは `examAuthorityKeys: true`)。
 */
export function runVerifyCliWithVerdicts(
  file: string,
  extraArgs: string[] = [],
  options: RunVerifyCliOptions = {}
): CliResultWithVerdicts {
  const outDir = mkdtempSync(join(tmpdir(), 'tc-e2e-verdicts-'));
  const analysisPath = join(outDir, 'analysis.json');
  const bundlePath = join(outDir, 'bundle.json');
  const resultPath = join(outDir, 'result.json');
  const res = runVerifyCli(
    file,
    [...extraArgs, '--analysis-json', analysisPath, '--analysis-bundle', bundlePath, '--result-json', resultPath],
    options
  );
  if (!existsSync(analysisPath) || !existsSync(bundlePath)) {
    throw new Error(`verify-cli wrote no analysis/bundle (exit ${res.exitCode})\n${res.stdout}${res.stderr}`);
  }
  const analysis = JSON.parse(readFileSync(analysisPath, 'utf-8')) as Array<{ filename: string; valid: boolean }>;
  const bundles = JSON.parse(readFileSync(bundlePath, 'utf-8')) as Array<{
    filename: string;
    assurance: CliVerdictEntry['assurance'];
    processSummary: CliVerdictEntry['processSummary'];
  }>;
  const results = JSON.parse(readFileSync(resultPath, 'utf-8')) as CliResultEntry[];
  const verdicts = analysis.map((a) => {
    const b = bundles.find((x) => x.filename === a.filename);
    if (!b) throw new Error(`no analysis bundle for ${a.filename}`);
    const r = results.find((x) => x.filename === a.filename);
    if (!r) throw new Error(`no result entry for ${a.filename}`);
    return {
      filename: a.filename,
      valid: a.valid,
      failedCheck: r.failedCheck,
      assurance: b.assurance,
      processSummary: b.processSummary,
    };
  });
  return { ...res, verdicts };
}
