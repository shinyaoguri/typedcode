#!/usr/bin/env node
/**
 * @typedcode/verify-cli - Typing proof file verifier
 *
 * Usage: typedcode-verify <file.json|file.zip> [--mode <m>] [--exam-package <f>] [--submitted-at <ISO>]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { verifyProof, type ProofFile } from './verify.js';
import { extractAllProofs } from './zip.js';
import { loadExternalAnalyzers } from './analyzers.js';
import { formatResult, printError, printUsage } from './output.js';
import { Spinner } from './progress.js';
import {
  parseExamPackageManifest,
  defaultAnalyzers,
  type VerificationMode,
  type ExamPackageManifest,
  type Analyzer,
} from '@typedcode/shared';

/** value を取る flag。`--name value` と `--name=value` の両方を許す。`--analyzer` は反復可。 */
const VALUE_FLAGS = new Set(['--mode', '--exam-package', '--submitted-at', '--analysis-json', '--analyzer']);

function flagValue(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  const arg = args[i]!;
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : args[i + 1];
}

/** 反復可能な value flag の値をすべて集める (`--analyzer a --analyzer b`)。 */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name) {
      const v = args[i + 1];
      if (v !== undefined) out.push(v);
      i++;
    } else if (arg.startsWith(`${name}=`)) {
      out.push(arg.slice(name.length + 1));
    }
  }
  return out;
}

function parseModeFlag(args: string[]): VerificationMode {
  const value = flagValue(args, '--mode');
  if (value === undefined) return 'full';
  if (value === 'fast' || value === 'audit' || value === 'full') return value;
  throw new Error(`Invalid --mode value: ${value}. Use fast | audit | full.`);
}

function nonFlagArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i++; // skip the flag's value
      continue;
    }
    if (arg.startsWith('--')) continue; // --flag=value or boolean flag
    out.push(arg);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
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

    spinner.stop();

    // 全 proof を検証。1 件でも fail なら exit 1 (CI が部分合格を成功と誤読しないように)。
    const multi = proofs.length > 1;
    const summary: Array<{ filename: string; valid: boolean }> = [];
    const analysisDump: Array<{ filename: string; valid: boolean; analysis: unknown }> = [];
    for (const { filename, proof } of proofs) {
      if (multi) console.log(`\n=== ${filename} ===`);
      const result = await verifyProof(proof, { mode, examPackageManifest, submittedAtMs, requireAnchorDensity, requireRootAnchor, analyzers });
      console.log(formatResult(result));
      summary.push({ filename, valid: result.valid });
      analysisDump.push({ filename, valid: result.valid, analysis: result.analysis });
    }

    // --analysis-json: AnalysisReport を機械可読でファイルへ (advisory、exit code 非干渉)。
    if (analysisJsonPath !== undefined) {
      await writeFile(resolve(analysisJsonPath), JSON.stringify(analysisDump, null, 2), 'utf-8');
      console.log(`\nAnalysis report written to ${analysisJsonPath}`);
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
