/**
 * Verification logic for CLI
 * Uses shared verification utilities from @typedcode/shared
 */

import {
  verifyProofFile,
  runAnalysis,
  verifyExamBinding,
  deriveAssurance,
  summarizeAnalysisForAssurance,
  summarizeProcess,
  normalizeProofLanguage,
  parseVersionStrict,
  EXAM_AUTHORITY_KEYS,
  type ProofFile,
  type VerificationProgressCallback,
  type VerificationMode,
  type FullVerificationResult,
  type Analyzer,
  type AnalysisReport,
  type AssuranceResult,
  type ProcessSummary,
  type ExamPackageManifest,
  type ExamBindingVerificationResult,
  type ScreenshotVerificationSummary,
  type CheckpointPublicKey,
  type ProofVersionStatus,
  type RootAnchorFailure,
  type AcceptancePolicyResult,
} from '@typedcode/shared';
import { ProgressBar } from './progress.js';

// Re-export ProofFile for use in other modules
export type { ProofFile };

/**
 * 試験モード (ADR-0006) の grader 結果。
 * - present: proof に exam ブロックがあるか。**`false` でも `--exam-package` が渡されていれば
 *   このオブジェクトは作られる** (#218: gate のサイレント無効化を許さない)。その場合
 *   examId / problemId / variant は無く、binding が shared の fail-closed 分岐の結果を持つ。
 * - rootBindingValid: proof 自己完結の exam root 束縛 (verifyProofFile の rootValid)。package 不要。
 *   非 exam proof (present=false) では意味を持たないので false 固定。
 * - binding: `.tcexam` が渡されたときのみ。署名 → packageHash → root → 内容ハッシュ → time-box。
 */
export type CLIExamResult =
  | {
      present: true;
      /**
       * 試験の識別子。`identifiersVerified` が true のときは検証済み manifest の値、false のときは
       * proof の**自己申告**値 (#273)。検証済みに見せないこと。
       */
      examId: string;
      problemId: string;
      variant: string | null;
      /** 識別子が束縛検証 (署名済み package との照合) を通った値か。package 未提供・束縛失敗では false */
      identifiersVerified: boolean;
      packageProvided: boolean;
      rootBindingValid: boolean;
      binding?: ExamBindingVerificationResult;
    }
  | {
      present: false;
      packageProvided: true;
      rootBindingValid: false;
      binding: ExamBindingVerificationResult;
    };

export interface CLIVerificationResult {
  valid: boolean;
  /**
   * 受理ポリシーと CLI の gate (exam 束縛・スクリーンショット・提出物) を足す前の結論
   * (shared の `FullVerificationResult.integrityValid`)。`--result-json` が載せる。
   */
  integrityValid: boolean;
  metadataValid: boolean;
  /** 以下 4 つと `sessionTokenMismatch` は shared の同名フィールド。`--result-json` の `failedCheck` を導く材料 */
  rootValid?: boolean;
  finalHashValid?: boolean;
  contentValid?: boolean;
  checkpointValid?: boolean;
  sessionTokenMismatch?: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  eventCount: number;
  duration: number;
  pasteEvents: number;
  dropEvents: number;
  poswIterations?: number;
  errorAt?: number;
  errorMessage?: string;
  language: string;
  mode: VerificationMode;
  poswSkipped: boolean;
  signedCheckpoints: FullVerificationResult['signedCheckpoints'];
  /** root がサーバアンカーされているか (ADR-0017) */
  rootAnchored: boolean;
  /**
   * token はあるが検証できなかった (#329。shared の `FullVerificationResult.rootAnchorFailure`)。
   * 改ざんではないので整合性は落ちないが、`valid` は false (exit 1)。`keyId` は proof 由来。
   */
  rootAnchorFailure?: RootAnchorFailure;
  /**
   * 受理ポリシー (#296 / ADR-0043) の評価結果 (shared の `FullVerificationResult.policy` そのもの)。
   * `--require-*` を 1 つも立てなければ `applied` は全部 false で、`violations` は空。
   * 整合性が落ちた proof では評価しない (`evaluated: false`)。
   */
  policy: AcceptancePolicyResult;
  /** 分析層 (ADR-0009) の advisory レポート。判定ではない。 */
  analysis: AnalysisReport;
  /** 三層保証語彙 (ADR-0020)。実証拠から機械導出した表示用語彙 (valid の置換ではない)。 */
  assurance: AssuranceResult;
  /** プロセス要約 (Phase 8 W3)。制作過程の中立な記述。 */
  processSummary: ProcessSummary;
  /** 試験モードの束縛検証 (ADR-0006)。exam proof でないときは undefined。 */
  exam?: CLIExamResult;
  /**
   * `proof.version` の分類 (#223)。`tooOld` / `malformed` は shared が `valid: false` にしている
   * (`errorMessage` に理由)。`newer` は reject せず、出力が warning を出す (exit code は他の検査で決まる)。
   */
  versionStatus?: ProofVersionStatus;
  /**
   * 自己申告 `proof.version` を `MAJOR.MINOR.PATCH` の数字だけに正規化した値。不正形式は undefined。
   * 表示に使ってよいのはこちらだけ (生の `proof.version` は攻撃者が書ける — shared AGENTS.md 不変条件 11)。
   */
  declaredVersion?: string;
  /**
   * スクリーンショット検証 (#147)。ZIP 入力で計算されたときのみ。undefined = 未検査
   * (JSON 単体入力など)。判定は shared の summarizeScreenshotArtifacts (verify web と同一実装)。
   */
  screenshots?: ScreenshotVerificationSummary;
}

/**
 * Tier A バンドル (ADR-0024) の `integrityValid` へ渡す値を導く (#219)。
 *
 * - `CLIVerificationResult.valid` は `--require-root-anchor` などの **gate 込み**の総合判定なので、
 *   「派生元 proof が整合性検証を通ったか」という ADR-0024 の契約とはずれる。そのまま渡すと
 *   gate で落ちただけの proof が `integrityValid: false` かつ `assurance.integrity: 'proven'` という
 *   自己矛盾したレコードになる。
 * - `=== 'proven'` にしないのは、ADR-0031 (#253) で `IntegrityLevel` に `'partial'` が入り fast モードが
 *   `'partial'` になるため。`'partial'` は「実施していない検査がある」であって「整合性が失敗した」では
 *   ないので、ここで false に潰してはいけない。
 */
export function toBundleIntegrityValid(assurance: AssuranceResult): boolean {
  return assurance.integrity !== 'failed';
}

export interface VerifyProofOptions {
  mode?: VerificationMode;
  /** `.tcexam` 問題パッケージ (任意)。あれば署名/復号/内容まで完全検証する。 */
  examPackageManifest?: ExamPackageManifest;
  /** Moodle 提出時刻 (epoch ms, 任意)。time-box の withinWindow 判定に使う。 */
  submittedAtMs?: number;
  /** anchoring 密度 gate (ADR-0016)。true で密度が疎な proof を fail させる (採点 opt-in, 受理ポリシー #296)。 */
  requireAnchorDensity?: boolean;
  /** root アンカー必須 (ADR-0017)。true で root 未アンカー (serverNonce トークン無し) を fail させる (採点 opt-in)。 */
  requireRootAnchor?: boolean;
  /** 署名 cp 必須 (#296)。true で署名 cp が 1 件も無い proof を fail させる (`--require-signed-checkpoints`)。 */
  requireSignedCheckpoints?: boolean;
  /** 最終署名必須 (#296)。true で最終イベントが署名 cp に覆われていない proof を fail させる (`--require-final-anchor`)。 */
  requireTerminalAnchor?: boolean;
  /**
   * 分析に使う Analyzer 群 (ADR-0009 / プラットフォーム方針)。未指定なら shared の
   * `defaultAnalyzers`。採点者/研究者の外部アナライザを CLI が読み込んで差し込むための口。
   * advisory のまま — valid / exit code には一切影響しない (直交性維持)。
   */
  analyzers?: readonly Analyzer[];
  /**
   * 分析器 1 つあたりの期限 (ms, #301)。未指定なら shared の `ANALYZER_TIMEOUT_MS` (10 秒)。
   * CLI オプションには出さない — テストが期限切れの経路を実時間 10 秒待たずに通すための継ぎ目。
   */
  analysisTimeoutMs?: number;
  /**
   * ZIP 全体のスクリーンショット検証サマリ (#147)。呼び出し側 (cli.ts) が ZIP から
   * 一度だけ計算して全 proof に渡す (スクショはセッション単位で proof 横断のため)。
   * tampered > 0 は verify (web) の error 軸と同じく valid を落とす。未指定 = 未検査。
   */
  screenshotSummary?: ScreenshotVerificationSummary;
  /**
   * 署名 cp / セッション開始トークンの公開鍵レジストリ。未指定なら shared の既定 registry
   * (本番運用はこちら)。テスト鍵を注入して web↔CLI パリティを比較するための口 (#216)。
   */
  signedCheckpointKeyRegistry?: readonly CheckpointPublicKey[];
}

/**
 * オブジェクトを再帰的に凍結する (#238 c3)。
 *
 * 用途は `FullVerificationResult` の凍結ひとつ。**event 数に比例するデータには使わないこと**
 * (proof 本体は分析層が読む必要があり、コピーも凍結もコストが event 数に比例する)。
 * ES module は strict mode なので、凍結後の代入は黙って無視されるのではなく TypeError で throw する。
 * 分析器が throw しても orchestrator がその分析器を `failed` として記録して続ける契約 (shared の
 * `Analyzer` の JSDoc, #301) なので、行儀の悪い分析器 1 つが他の分析器を巻き添えにすることはない。
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** 自己申告 version のうち、表示してよい形 (`MAJOR.MINOR.PATCH` の数字だけ) に正規化する */
function declaredVersion(version: unknown): string | undefined {
  const parsed = parseVersionStrict(version);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : undefined;
}

export async function verifyProof(proof: ProofFile, options: VerifyProofOptions = {}): Promise<CLIVerificationResult> {
  const mode: VerificationMode = options.mode ?? 'full';
  const startTime = performance.now();
  const events = proof.proof.events;
  const eventCount = events.length;

  // Setup progress bar
  console.log('');
  const progressBar = new ProgressBar(eventCount, 'Verifying');

  const onProgress: VerificationProgressCallback = (current) => {
    progressBar.update(current);
  };

  // 試験モード (ADR-0006): package が渡されたら**必ず**束縛を検証する。
  // #218: ここで `proof.exam &&` を条件にすると、exam ブロックの無い proof に package を渡したとき
  // 何も検証されず exit 0 で通る (採点ゲートのサイレント無効化)。shared の `verifyExamBinding` は
  // exam ブロック無しを fail-closed で弾く (`reason: 'Proof has no exam block'`) ので、そこへ到達させる。
  // root アンカー gate (#131) の exam 免除は「検証済み束縛」に基づくため verifyProofFile より前に計算する。
  const binding = options.examPackageManifest
    ? await verifyExamBinding(proof, options.examPackageManifest, {
        examAuthorityRegistry: EXAM_AUTHORITY_KEYS,
        submissionTimeMs: options.submittedAtMs,
      })
    : undefined;

  // Run verification using shared utilities
  const result = await verifyProofFile(proof, onProgress, {
    mode,
    requireAnchorDensity: options.requireAnchorDensity,
    requireRootAnchor: options.requireRootAnchor,
    requireSignedCheckpoints: options.requireSignedCheckpoints,
    requireTerminalAnchor: options.requireTerminalAnchor,
    // 免除は検証済み束縛のみ。package 未提供 (binding=undefined) の exam proof は gate 対象。
    examBindingVerified: binding?.valid === true,
    signedCheckpointKeyRegistry: options.signedCheckpointKeyRegistry,
  });

  progressBar.complete();

  // #238 (c3): 検証結果を凍結してから分析層へ渡す。`AnalysisInput.verification` は
  // このオブジェクトそのものなので、凍結しないと外部 analyzer が `valid` 等を書き換えられる。
  // 小さなサマリ (signedCheckpoints.details は署名 cp 数ぶんで event 数には比例しない) なので
  // 深く凍結してよい。以降このオブジェクトは誰も書き換えない。
  deepFreeze(result);

  // 試験モード (ADR-0006): root 束縛は proof 自己完結 (verifyProofFile が rootValid で検証済み)。
  // package が渡されたときのみ署名/復号/内容まで完全検証する (binding は上で計算済み)。
  // #218: package を渡したのに exam ブロックが無い proof も結果に載せる (present: false)。
  // 黙って無視すると採点者に何も見えないまま exit 0 で通る。
  let exam: CLIExamResult | undefined;
  if (proof.exam) {
    // #273: 束縛が合格したときだけ検証済み manifest 側の識別子を載せる。それ以外 (package 未提供・
    // 束縛失敗) は proof の自己申告値のままで、identifiersVerified=false で区別する。
    const verifiedIds = binding?.valid ? binding.verifiedIds : undefined;
    exam = {
      present: true,
      examId: verifiedIds?.examId ?? proof.exam.examId,
      problemId: verifiedIds?.problemId ?? proof.exam.problemId,
      variant: verifiedIds ? verifiedIds.variant : (proof.exam.variant ?? null),
      identifiersVerified: verifiedIds !== undefined,
      packageProvided: !!options.examPackageManifest,
      rootBindingValid: result.rootValid ?? false,
      binding,
    };
  } else if (binding) {
    exam = {
      present: false,
      packageProvided: true,
      rootBindingValid: false,
      binding,
    };
  }

  // Calculate statistics
  const pasteEvents = events.filter((e) => e.inputType === 'insertFromPaste').length;
  const dropEvents = events.filter((e) => e.inputType === 'insertFromDrop').length;

  const firstPoswEvent = events.find((e) => e.posw);
  const poswIterations = firstPoswEvent?.posw?.iterations;

  // package が渡されたとき、束縛失敗は全体を fail にする (proof 自己整合とは別軸の真正性)。
  const examValid = exam?.binding ? exam.binding.valid : true;

  // #147: スクショ改ざんは verify (web) の error 軸 (TrustCalculator/integrity failed) と同じく
  // 全体 fail = exit 1 に合流させる。欠損/chainOnly は warning (web と同じ) で exit 非干渉。
  const screenshotsValid = (options.screenshotSummary?.tampered ?? 0) === 0;

  // proof 由来の自己申告値。生値のままだと Language: 行から改行や ANSI を stdout へ
  // 流し込める (#248 / #266)。allowlist に落として渡す。
  const language = normalizeProofLanguage(proof.language);
  const processSummary = summarizeProcess(events);

  // 判定に効く値 (exit code を決める valid、および三層保証の integrity / authenticity の入力) は
  // **ここまでですべて確定している**。分析層より後に読むのは `analysis` だけ、という並びを保つこと。
  // #238 (c3): 以前は runAnalysis がここより前に走っており、`AnalysisInput.verification` 経由で
  // 外部 analyzer が `result.valid` を書き換えると改ざん proof が exit 0 になった。
  // ADR-0009 / ADR-0023 の「advisory は判定に漏れない」を、凍結 (上) と順序 (ここ) の二重で担保する。
  const valid = result.valid && examValid && screenshotsValid;

  // 分析層 (ADR-0009): 検証と直交する post-hoc 分析。既定の分析器は方向性を示す
  // プレースホルダのみ。advisory であって判定ではない (verifyProofFile の valid とは別軸)。
  // options.analyzers が渡れば (採点者/研究者の外部アナライザ) それを使う。未指定なら shared 既定。
  // 分析器ごとに期限があり (#301)、throw・期限切れ・不正な出力は analyzerStatus に残って先へ進む。
  // 解決しない Promise を返す分析器でも、検証結果の出力と exit code はここで止まらない。
  const analysis = await runAnalysis({ proof, verification: result }, options.analyzers, {
    timeoutMs: options.analysisTimeoutMs,
  });

  const duration = (performance.now() - startTime) / 1000;

  // 三層保証語彙 (ADR-0020): 実証拠のみから導出 (自己申告 mode は使わない)。
  // analysis は `process` 層 (notableSignals / reviewPriority) にしか流れない (shared/assurance.ts)。
  const assurance = deriveAssurance({
    metadataValid: result.metadataValid,
    chainValid: result.chainValid,
    exam: exam
      ? {
          // #218: present を固定値にしない。exam ブロックの無い proof への package 提供は
          // 「gate の誤用」であって改ざんではないので、integrity を failed に落とさせない
          // (deriveAssurance は present === true のときだけ束縛失敗を integrity に流す)。
          present: exam.present,
          packageProvided: exam.packageProvided,
          bindingValid: exam.binding?.valid,
        }
      : undefined,
    rootAnchored: result.rootAnchored ?? false,
    signedCheckpoints: result.signedCheckpoints
      ? {
          anchored: result.signedCheckpoints.anchored,
          valid: result.signedCheckpoints.valid,
          sparse: result.signedCheckpoints.density?.sparse,
          postHocSuspected: result.signedCheckpoints.temporal?.postHocSuspected,
          // #295: 最後の署名 cp が最終イベントまで届いていなければ anchored を名乗らない。
          terminal: result.signedCheckpoints.coverage.terminalAnchored,
        }
      : undefined,
    // #295: token と署名 cp の sessionId が食い違えば、その cp を時刻証拠に数えない。
    sessionTokenMismatch: result.sessionTokenMismatch ?? false,
    isPureTyping: result.isPureTyping,
    // ok の分析器が 1 つも無ければ undefined (= 分析未実行) になり、Authorship に `review 0%` を出さない (#301)。
    analysis: summarizeAnalysisForAssurance(analysis),
    // #147: ZIP 入力で検査したときのみ渡す (undefined = 未検査は integrity に影響しない)。
    screenshotsTampered: options.screenshotSummary?.tampered,
    // #214: fast モードは PoSW を再計算していないので integrity を proven に上げない。
    poswSkipped: result.poswSkipped ?? false,
  });

  return {
    valid,
    integrityValid: result.integrityValid,
    metadataValid: result.metadataValid,
    rootValid: result.rootValid,
    finalHashValid: result.finalHashValid,
    contentValid: result.contentValid,
    checkpointValid: result.checkpointValid,
    sessionTokenMismatch: result.sessionTokenMismatch,
    chainValid: result.chainValid,
    isPureTyping: result.isPureTyping,
    eventCount,
    duration,
    pasteEvents,
    dropEvents,
    poswIterations,
    errorAt: result.errorAt,
    errorMessage: result.errorMessage,
    language,
    mode,
    poswSkipped: result.poswSkipped ?? false,
    signedCheckpoints: result.signedCheckpoints,
    rootAnchored: result.rootAnchored ?? false,
    rootAnchorFailure: result.rootAnchorFailure,
    policy: result.policy,
    analysis,
    assurance,
    processSummary,
    exam,
    versionStatus: result.versionStatus,
    declaredVersion: declaredVersion(proof.version),
    screenshots: options.screenshotSummary,
  };
}
