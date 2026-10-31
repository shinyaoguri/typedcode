#!/usr/bin/env node
/**
 * @typedcode/verify-cli - Typing proof file verifier
 *
 * Usage: typedcode-verify <file.json|file.zip>... [--mode <m>] [--exam-package <f>] [--submitted-at <ISO>]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { verifyProof, toBundleIntegrityValid, type ProofFile } from './verify.js';
import { extractAllProofs, extractScreenshotArtifacts } from './zip.js';
import { loadExternalAnalyzers } from './analyzers.js';
import {
  formatMultiSummary,
  formatProofHeader,
  formatResult,
  formatUnreadableProof,
  printError,
  printUsage,
} from './output.js';
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
  type ProofExtractionFailure,
} from '@typedcode/shared';

import { findFlagError, flagValue, flagValues, nonFlagArgs } from './args.js';

function parseModeFlag(args: string[]): VerificationMode {
  const value = flagValue(args, '--mode');
  if (value === undefined) return 'full';
  if (value === 'fast' || value === 'audit' || value === 'full') return value;
  throw new Error(`Invalid --mode value: ${value}. Use fast | audit | full.`);
}

async function main(): Promise<void> {
  // fail-closed (#315): 既定は失敗。0 に下ろすのは `--help` と成功の集計だけ。
  // 終了は自然終了 (#283) なので、解決しない Promise (外部 analyzer など) で途中のまま
  // イベントループが空になると、ここで立てた値のまま終わる。既定 0 だと改ざん proof が exit 0 になる。
  process.exitCode = 1;
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exitCode = args.length === 0 ? 1 : 0;
    return;
  }

  // 未知フラグ・タイポ・値欠落は黙殺せず usage error (#148)。
  // タイポでセキュリティゲート (--require-root-anchor 等) が無効のまま exit 0 になるのを防ぐ。
  const flagError = findFlagError(args);
  if (flagError !== null) {
    printError(flagError);
    printUsage();
    process.exitCode = 1;
    return;
  }

  const mode = parseModeFlag(args);
  const positional = nonFlagArgs(args);
  if (positional.length === 0) {
    printError('No proof file given.');
    printUsage();
    process.exitCode = 1;
    return;
  }
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
      process.exitCode = 1;
      return;
    }
    let external: Analyzer[];
    try {
      external = await loadExternalAnalyzers(analyzerPaths);
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
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
      process.exitCode = 1;
      return;
    }
    // #218: --submitted-at は time-box (advisory) の判定にしか使われず、time-box は package の
    // manifest にしか無い。単独で渡しても黙って捨てられるので、その旨を出す (advisory なので
    // exit code は変えない — 束縛ゲートの無効化とは性質が違う)。
    if (examPackagePath === undefined) {
      console.warn(
        'Warning: --submitted-at has no effect without --exam-package (the time-box comes from the package).'
      );
    }
  }

  // 問題パッケージ (.tcexam) の読込・パース (任意)。全入力に共通で適用するので一度だけ読む。
  // 読めない・不正なら、どの入力も検証できないので全体を失敗にする。
  let examPackageManifest: ExamPackageManifest | undefined;
  if (examPackagePath !== undefined) {
    try {
      const raw = await readFile(resolve(examPackagePath), 'utf-8');
      const parsed = parseExamPackageManifest(JSON.parse(raw));
      if (!parsed) {
        printError(`Invalid exam package (.tcexam): ${examPackagePath}`);
        process.exitCode = 1;
        return;
      }
      examPackageManifest = parsed;
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  // 位置引数はすべて検証する (#294)。入力ごとの読込・パース・拡張子の失敗は全体を落とさず、
  // summary に失敗として積んで残りの入力へ進む。1 件でも失敗なら最後に exit 1。
  const multiInput = positional.length > 1;
  const summary: Array<{ filename: string; valid: boolean; reason?: string }> = [];
  const analysisDump: Array<{ filename: string; valid: boolean; analysis: unknown }> = [];
  const bundleDump: Array<{ filename: string } & AnalysisBundle> = [];

  for (const input of positional) {
    const spinner = new Spinner('Loading proof file...');
    spinner.start();

    // 検証対象の proof 群 (ZIP は全タブ分、JSON は 1 件)
    let proofs: Array<{ filename: string; proof: ProofFile }>;
    // ZIP 内の `*_proof.json` のうち proof として読めなかったもの (#292)。1 件でも失敗として数える。
    let unreadable: ProofExtractionFailure[] = [];
    let screenshotSummary: ScreenshotVerificationSummary | undefined;
    try {
      const filePath = resolve(input);
      const ext = extname(filePath).toLowerCase();

      if (ext === '.zip') {
        const { proofs: extracted, failures } = await extractAllProofs(filePath);
        // 壊れた proof しか無い ZIP は「proof が無い」ではなく破損として報告する (下の failures 出力)。
        if (extracted.length === 0 && failures.length === 0) {
          throw new Error('No proof file found in ZIP');
        }
        unreadable = multiInput ? failures.map((f) => ({ ...f, filename: `${input}:${f.filename}` })) : failures;
        // 入力が複数のとき、別々の ZIP に同名の entry (`tab1_proof.json` など) があっても
        // summary / --analysis-* の filename が衝突しないよう入力名を前置する。
        proofs = multiInput
          ? extracted.map((p) => ({ filename: `${input}:${p.filename}`, proof: p.proof }))
          : extracted;

        // スクリーンショット検証 (#147): ZIP 入力ごとに一度だけ計算して、その ZIP の全 proof に渡す
        // (スクショはセッション単位で proof 横断)。真正記録は各チェーンの screenshotCapture.imageHash。
        // JSON 単体入力は画像が無いので未検査 (undefined) — 出力で明示する (overclaim 防止)。
        const chainImageHashes = collectChainImageHashes(proofs.map((p) => p.proof.proof.events));
        const artifacts = await extractScreenshotArtifacts(filePath);
        // スクショ無しセッション (manifest もチェーン記録も無し) は全ゼロの summary になり
        // 出力上は沈黙する。undefined は「検査できない」(JSON 単体入力) の意味に限定する。
        screenshotSummary = await summarizeScreenshotArtifacts({
          entries: artifacts?.entries ?? [],
          getImageBytes: async (filename) => artifacts?.images.get(filename) ?? null,
          chainImageHashes,
        });
      } else if (ext === '.json') {
        const content = await readFile(filePath, 'utf-8');
        const proof = JSON.parse(content) as ProofFile;
        if (!proof.proof || !proof.typingProofHash) {
          throw new Error('Invalid proof file structure');
        }
        proofs = [{ filename: input, proof }];
      } else {
        throw new Error(`Unsupported file type: ${ext}. Use .json or .zip`);
      }
    } catch (error) {
      spinner.stop();
      const reason = error instanceof Error ? error.message : String(error);
      // 複数入力のときは、どの入力の失敗か分かるよう入力名を前置する。
      printError(multiInput ? `${input}: ${reason}` : reason);
      summary.push({ filename: input, valid: false, reason });
      continue;
    }

    spinner.stop();

    // 全 proof を検証。1 件でも fail なら exit 1 (CI が部分合格を成功と誤読しないように)。
    const multi = multiInput || proofs.length + unreadable.length > 1;
    for (const { filename, proof } of proofs) {
      if (multi) console.log(formatProofHeader(filename));
      let result: Awaited<ReturnType<typeof verifyProof>>;
      try {
        result = await verifyProof(proof, {
          mode,
          examPackageManifest,
          submittedAtMs,
          requireAnchorDensity,
          requireRootAnchor,
          analyzers,
          screenshotSummary,
        });
      } catch (error) {
        // 1 件の検証中の例外で残りの入力を未検証のまま落とさない。失敗として数えて続ける。
        const reason = error instanceof Error ? error.message : String(error);
        printError(`${filename}: ${reason}`);
        summary.push({ filename, valid: false, reason });
        continue;
      }
      console.log(formatResult(result));
      summary.push({ filename, valid: result.valid });
      analysisDump.push({ filename, valid: result.valid, analysis: result.analysis });
      // Tier A バンドル (ADR-0024): content-free な派生ビュー。--analysis-bundle 指定時のみ集める。
      if (analysisBundlePath !== undefined) {
        const bundle = buildAnalysisBundle({
          // #219: gate 込みの result.valid ではなく整合性そのものを渡す (理由は関数の doc)。
          integrityValid: toBundleIntegrityValid(result.assurance),
          processSummary: result.processSummary,
          analysis: result.analysis,
          assurance: result.assurance,
        });
        bundleDump.push({ filename, ...bundle });
      }
    }

    // 読めなかった proof も他の proof の検証を止めず、失敗として summary に積む (#292)。
    // 単独でもファイル名が出るよう、ヘッダは multi に関係なく出す。
    for (const { filename, reason } of unreadable) {
      console.log(formatProofHeader(filename));
      console.log(formatUnreadableProof(reason));
      summary.push({ filename, valid: false, reason });
    }
  }

  try {
    // --analysis-json: AnalysisReport を機械可読でファイルへ (advisory、exit code 非干渉)。
    // 読めなかった入力は分析が無いので載らない (失敗は summary と exit code に出る)。
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

    if (summary.length > 1) {
      console.log(formatMultiSummary(summary));
    }

    process.exitCode = summary.every((s) => s.valid) ? 0 : 1;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
