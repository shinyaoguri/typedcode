#!/usr/bin/env node
/**
 * @typedcode/verify-cli - Typing proof file verifier
 *
 * Usage: typedcode-verify <file.json|file.zip>... [--mode <m>] [--exam-package <f>] [--submitted-at <ISO>]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { verifyProof, toBundleIntegrityValid, type ProofFile } from './verify.js';
import { extractAllProofs, extractScreenshotArtifacts, extractSubmissionSources } from './zip.js';
import { loadExternalAnalyzers } from './analyzers.js';
import { createDirNamer, extractProofSources, type ExtractVerification } from './extractSources.js';
import {
  formatExtractedSources,
  formatMultiSummary,
  formatOrphanSources,
  formatProofHeader,
  formatResult,
  formatUnreadableProof,
  printError,
  printUsage,
  safe,
} from './output.js';
import { Spinner } from './progress.js';
import {
  parseExamPackageManifestResult,
  defaultAnalyzers,
  buildAnalysisBundle,
  collectChainImageHashes,
  summarizeScreenshotArtifacts,
  matchSubmissionSources,
  submissionSeverity,
  type SubmissionReport,
  type SubmissionSourceInput,
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

  // 提出物の書き出し (#409): ZIP の proof ごとに submitted / verified / report.json を書く。
  // 検証の判定には触れない (書き出しの失敗だけ exit 1 に倒す)。元のソースと既存のファイルは上書きしない。
  const extractSourcesDir = flagValue(args, '--extract-sources');
  const dirNamer = createDirNamer();
  let extractFailures = 0;

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
      const parsed = parseExamPackageManifestResult(JSON.parse(raw));
      if (!parsed.ok) {
        // #223: 「壊れている」と「この verifier より新しい形式」を出し分ける (reason は shared の固定文言)。
        const hint =
          parsed.code === 'unsupportedFormatVersion'
            ? parsed.newer
              ? ' Use an up-to-date verify-cli.'
              : ' This package predates the supported format; ask the exam administrator for a new one.'
            : '';
        // printError は 200 字で切り詰めるので、理由と案内を先に、(長くなりうる) パスを最後に置く。
        printError(`Invalid exam package (.tcexam): ${parsed.reason}.${hint} (${examPackagePath})`);
        process.exitCode = 1;
        return;
      }
      examPackageManifest = parsed.manifest;
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
    // 提出物の照合 (#293)。undefined = 未検査 (JSON 単体入力は同梱ソースが無い)。
    let submissionReport: SubmissionReport | undefined;
    // ZIP の同梱ソース候補 (生バイト)。`--extract-sources` が対のソースの本体を引く。
    let submissionSources: SubmissionSourceInput[] = [];
    // 表示名 (複数入力のときは入力名つき) → proof の ZIP 内パス。照合は ZIP 内のパスで行う。
    const entryPathOf = new Map<string, string>();
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
        // 提出物の照合 (#293): 同梱ソースと proof.content を対応規則 (shared) で対にして照合する。
        // 壊れた proof も欠番として渡す (後続タブのソース名を確定できなくなるため)。
        submissionSources = await extractSubmissionSources(filePath);
        submissionReport = matchSubmissionSources({
          // 自己申告の欄は未検証なので unknown のまま渡す (型の確認は shared が行う)。
          proofs: extracted.map((p) => {
            const claim = p.proof as unknown as { filename?: unknown; language?: unknown; content?: unknown };
            return { path: p.filename, filename: claim.filename, language: claim.language, content: claim.content };
          }),
          unreadableProofPaths: failures.map((f) => f.filename),
          sources: submissionSources,
        });
        // 入力が複数のとき、別々の ZIP に同名の entry (`tab1_proof.json` など) があっても
        // summary / --analysis-* の filename が衝突しないよう入力名を前置する。
        proofs = multiInput
          ? extracted.map((p) => ({ filename: `${input}:${p.filename}`, proof: p.proof }))
          : extracted;
        for (const [i, p] of extracted.entries()) entryPathOf.set(proofs[i]!.filename, p.filename);

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
        if (extractSourcesDir !== undefined) {
          console.warn(
            `Warning: --extract-sources only applies to ZIP inputs; nothing was extracted from ${safe(input)}.`
          );
        }
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
      const entryPath = entryPathOf.get(filename);
      const pair =
        submissionReport && entryPath !== undefined
          ? submissionReport.pairs.find((p) => p.proofPath === entryPath)
          : undefined;

      // 提出物の書き出し (#409)。検証の成否にかかわらず (検証が例外で止まっても) 書く。
      // 失敗は検証の判定とは独立に数え、最後に exit 1 へ倒す。
      const extract = async (verification: ExtractVerification): Promise<void> => {
        if (extractSourcesDir === undefined || entryPath === undefined) return;
        const claim = proof as unknown as { filename?: unknown; language?: unknown; content?: unknown };
        try {
          const written = await extractProofSources({
            outDir: extractSourcesDir,
            namer: dirNamer,
            input,
            proofEntry: entryPath,
            proofFilename: claim.filename,
            language: claim.language,
            content: claim.content,
            pair,
            sourceBytes:
              pair?.expectedSource !== undefined
                ? submissionSources.find((s) => s.path === pair.expectedSource)?.bytes
                : undefined,
            verification,
          });
          console.log(formatExtractedSources(written.dir, written.files));
        } catch (error) {
          extractFailures++;
          printError(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

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
        await extract({ kind: 'error', reason });
        continue;
      }
      // 提出物の不整合は proof 自体の改ざんではないので integrity (assurance) は落とさず、総合 valid だけを落とす (#293)。
      const submission =
        submissionReport && pair ? { pair, severity: submissionSeverity(submissionReport, pair) } : undefined;
      const valid = result.valid && submission?.severity !== 'failure';
      console.log(formatResult({ ...result, valid, submission }));
      await extract({
        kind: 'completed',
        valid,
        chainValid: result.chainValid,
        metadataValid: result.metadataValid,
        integrity: result.assurance.integrity,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      });
      summary.push({
        filename,
        valid,
        ...(result.valid && !valid ? { reason: 'Submission: bundled source does not match the verified proof' } : {}),
      });
      analysisDump.push({ filename, valid, analysis: result.analysis });
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

    // 孤立ソース (どの proof の期待名にも当たらない同梱ファイル) は警告だけ。exit code には影響しない (#293)。
    if (submissionReport && submissionReport.orphanSources.length > 0) {
      console.log(formatOrphanSources(submissionReport.orphanSources));
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

    process.exitCode = summary.every((s) => s.valid) && extractFailures === 0 ? 0 : 1;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
