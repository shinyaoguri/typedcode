#!/usr/bin/env node
/**
 * @typedcode/verify-cli - Typing proof file verifier
 *
 * Usage: typedcode-verify <file.json|file.zip> [--mode <m>] [--exam-package <f>] [--submitted-at <ISO>]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { verifyProof, type ProofFile } from './verify.js';
import { extractAllProofs, extractScreenshotArtifacts } from './zip.js';
import { loadExternalAnalyzers } from './analyzers.js';
import { formatResult, printError, printUsage } from './output.js';
import { Spinner } from './progress.js';
import {
  parseExamPackageManifest,
  defaultAnalyzers,
  buildAnalysisBundle,
  collectChainImageHashes,
  summarizeScreenshotArtifacts,
  type VerificationMode,
  type ExamPackageManifest,
  type Analyzer,
  type AnalysisBundle,
  type ScreenshotVerificationSummary,
} from '@typedcode/shared';

import { findFlagError, flagValue, flagValues, nonFlagArgs } from './args.js';

function parseModeFlag(args: string[]): VerificationMode {
  const value = flagValue(args, '--mode');
  if (value === undefined) return 'full';
  if (value === 'fast' || value === 'audit' || value === 'full') return value;
  throw new Error(`Invalid --mode value: ${value}. Use fast | audit | full.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  // 未知フラグ・タイポ・値欠落は黙殺せず usage error (#148)。
  // タイポでセキュリティゲート (--require-root-anchor 等) が無効のまま exit 0 になるのを防ぐ。
  const flagError = findFlagError(args);
  if (flagError !== null) {
    printError(flagError);
    printUsage();
    process.exit(1);
  }

  const mode = parseModeFlag(args);
  const positional = nonFlagArgs(args);
  if (positional.length === 0) {
    printError('No proof file given.');
    printUsage();
    process.exit(1);
  }
  const filePath = resolve(positional[0]!);
  const ext = extname(filePath).toLowerCase();

  // anchoring 密度 gate (ADR-0016): boolean フラグ。指定すると密度が疎な proof を fail させる。
  const requireAnchorDensity = args.includes('--require-anchor-density');

  // root アンカー gate (ADR-0017): boolean フラグ。指定すると root 未アンカー proof を fail させる。
  const requireRootAnchor = args.includes('--require-root-anchor');

  // 分析レポートの JSON 出力 (ADR-0009): 評価ハーネス/集計スクリプトの機械可読な入口。
  // advisory であって判定ではない — exit code には一切影響しない。
  const analysisJsonPath = flagValue(args, '--analysis-json');

  // Tier A バンドル出力 (ADR-0024): content-free な {ProcessSummary, Analysis, Assurance}
  // をファイルへ。コホート基準 (ADR-0025) の入力フォーマット。advisory・exit code 非干渉。
  const analysisBundlePath = flagValue(args, '--analysis-bundle');

  // 外部アナライザ (ADR-0009 / プラットフォーム方針): 採点者/研究者が自前の Analyzer を
  // フォークせず差し込む口。`--analyzer <path>` 反復可、`--no-default-analyzers` で既定を外す。
  // すべて advisory — exit code には一切影響しない。
  const analyzerPaths = flagValues(args, '--analyzer');
  const noDefaultAnalyzers = args.includes('--no-default-analyzers');
  let analyzers: readonly Analyzer[] | undefined;
  if (analyzerPaths.length > 0 || noDefaultAnalyzers) {
    if (noDefaultAnalyzers && analyzerPaths.length === 0) {
      printError('--no-default-analyzers requires at least one --analyzer <path>.');
      process.exit(1);
    }
    let external: Analyzer[];
    try {
      external = await loadExternalAnalyzers(analyzerPaths);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    analyzers = noDefaultAnalyzers ? external : [...defaultAnalyzers, ...external];
    const names = analyzers.map((a) => `${a.id}@${a.version}`).join(', ');
    console.log(`Analyzers: ${names}${noDefaultAnalyzers ? ' (defaults disabled)' : ''}`);
  }

  // 試験モード (ADR-0006): 任意の問題パッケージ + 提出時刻
  const examPackagePath = flagValue(args, '--exam-package');
  const submittedAtRaw = flagValue(args, '--submitted-at');
  let submittedAtMs: number | undefined;
  if (submittedAtRaw !== undefined) {
    submittedAtMs = Date.parse(submittedAtRaw);
    if (Number.isNaN(submittedAtMs)) {
      printError(`Invalid --submitted-at value: ${submittedAtRaw}. Use an ISO 8601 timestamp.`);
      process.exit(1);
    }
  }

  try {
    const spinner = new Spinner('Loading proof file...');
    spinner.start();

    // 検証対象の proof 群 (ZIP は全タブ分、JSON は 1 件)
    let proofs: Array<{ filename: string; proof: ProofFile }>;

    if (ext === '.zip') {
      proofs = await extractAllProofs(filePath);
      if (proofs.length === 0) {
        throw new Error('No proof file found in ZIP');
      }
    } else if (ext === '.json') {
      const content = await readFile(filePath, 'utf-8');
      const proof = JSON.parse(content) as ProofFile;
      if (!proof.proof || !proof.typingProofHash) {
        throw new Error('Invalid proof file structure');
      }
      proofs = [{ filename: positional[0]!, proof }];
    } else {
      spinner.stop();
      printError(`Unsupported file type: ${ext}. Use .json or .zip`);
      process.exit(1);
    }

    // 問題パッケージ (.tcexam) の読込・パース (任意)
    let examPackageManifest: ExamPackageManifest | undefined;
    if (examPackagePath !== undefined) {
      const raw = await readFile(resolve(examPackagePath), 'utf-8');
      const parsed = parseExamPackageManifest(JSON.parse(raw));
      if (!parsed) {
        spinner.stop();
        printError(`Invalid exam package (.tcexam): ${examPackagePath}`);
        process.exit(1);
      }
      examPackageManifest = parsed;
    }

    // スクリーンショット検証 (#147): ZIP 入力のとき一度だけ計算して全 proof に渡す
    // (スクショはセッション単位で proof 横断)。真正記録は各チェーンの screenshotCapture.imageHash。
    // JSON 単体入力は画像が無いので未検査 (undefined) — 出力で明示する (overclaim 防止)。
    let screenshotSummary: ScreenshotVerificationSummary | undefined;
    if (ext === '.zip') {
      const chainImageHashes = collectChainImageHashes(proofs.map((p) => p.proof.proof.events));
      const artifacts = await extractScreenshotArtifacts(filePath);
      // スクショ無しセッション (manifest もチェーン記録も無し) は全ゼロの summary になり
      // 出力上は沈黙する。undefined は「検査できない」(JSON 単体入力) の意味に限定する。
      screenshotSummary = await summarizeScreenshotArtifacts({
        entries: artifacts?.entries ?? [],
        getImageBytes: async (filename) => artifacts?.images.get(filename) ?? null,
        chainImageHashes,
      });
    }

    spinner.stop();

    // 全 proof を検証。1 件でも fail なら exit 1 (CI が部分合格を成功と誤読しないように)。
    const multi = proofs.length > 1;
    const summary: Array<{ filename: string; valid: boolean }> = [];
    const analysisDump: Array<{ filename: string; valid: boolean; analysis: unknown }> = [];
    const bundleDump: Array<{ filename: string } & AnalysisBundle> = [];
    for (const { filename, proof } of proofs) {
      if (multi) console.log(`\n=== ${filename} ===`);
      const result = await verifyProof(proof, { mode, examPackageManifest, submittedAtMs, requireAnchorDensity, requireRootAnchor, analyzers, screenshotSummary });
      console.log(formatResult(result));
      summary.push({ filename, valid: result.valid });
      analysisDump.push({ filename, valid: result.valid, analysis: result.analysis });
      // Tier A バンドル (ADR-0024): content-free な派生ビュー。--analysis-bundle 指定時のみ集める。
      if (analysisBundlePath !== undefined) {
        const bundle = buildAnalysisBundle({
          integrityValid: result.valid,
          processSummary: result.processSummary,
          analysis: result.analysis,
          assurance: result.assurance,
        });
        bundleDump.push({ filename, ...bundle });
      }
    }

    // --analysis-json: AnalysisReport を機械可読でファイルへ (advisory、exit code 非干渉)。
    if (analysisJsonPath !== undefined) {
      await writeFile(resolve(analysisJsonPath), JSON.stringify(analysisDump, null, 2), 'utf-8');
      console.log(`\nAnalysis report written to ${analysisJsonPath}`);
    }

    // --analysis-bundle: Tier A バンドル群 (ProcessSummary + Analysis + Assurance、content-free)
    // を機械可読でファイルへ。コホート基準 (ADR-0025) の入力。advisory・exit code 非干渉。
    if (analysisBundlePath !== undefined) {
      await writeFile(resolve(analysisBundlePath), JSON.stringify(bundleDump, null, 2), 'utf-8');
      console.log(`\nAnalysis bundle (Tier A) written to ${analysisBundlePath}`);
    }

    if (multi) {
      const passed = summary.filter((s) => s.valid).length;
      console.log(`\n=== Summary: ${passed}/${summary.length} proofs passed ===`);
      for (const s of summary) {
        console.log(`  ${s.valid ? '✓' : '✗'} ${s.filename}`);
      }
    }

    process.exit(summary.every((s) => s.valid) ? 0 : 1);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
