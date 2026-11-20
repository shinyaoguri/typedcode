/**
 * 仕様別の検証 (#809 / ADR-0053) の入力と共通の結果の型。
 *
 * **ここの型名は内部用**。外部へ公開する名前と enum の値は #811 (SDK) で確定するので、それまでは
 * shared の中と verify / verify-cli の切り替え作業 (#811) からだけ使う前提で置く。
 *
 * 結果は ADR-0053 §4 の軸を分けて返す:
 * - `support`: 入力をどの仕様の検証器で読んだか (対応状況)
 * - `checks`: 検査ごとの pass / fail / not-checked / not-applicable
 * - `integrity` と `limitations`: 保証範囲 (`checks` から導く整合性と、省略・欠落した検査)
 * - `trust`: 信頼に使った鍵一覧の識別と、証拠に現れた鍵ごとの信頼状態
 * - `acceptance`: 受理ポリシー (ADR-0043) への適合
 * - `evaluation`: 評価時刻とモード (入力の写し)
 */

import type { AcceptancePolicy, AcceptancePolicyResult } from '../acceptancePolicy.js';
import type { IntegrityLevel } from '../assurance.js';
import type { CheckpointPublicKey } from '../checkpointKeys/index.js';
import type { RegistryKeyTrustStatus } from '../checkpointKeys/keyValidity.js';
import type { ExamBindingVerificationResult } from '../exam/examPackage.js';
import type { ExamAuthorityKey } from '../examAuthorityKeys/index.js';
import type { ChainFailureCode } from '../types/verification.js';
import type {
  FullVerificationResult,
  RootAnchorFailureCode,
  VerificationMode,
  VerificationProgressCallback,
} from '../verification.js';

/** 共通の結果の形の版。結果の形を変えたら上げる (仕様の版とも、アプリの版とも別。ADR-0053 §1) */
export const SPEC_RESULT_SCHEMA = 1 as const;

/** 登録済みの仕様の識別子。いまは legacy の typing proof 1.2.0 だけ (2026-11-20 メンテナ決定。ADR-0053 §2) */
export type SpecId = 'legacy-typing-proof@1.2.0';

/**
 * 信頼の入力。既定の registry に黙って落とさないよう、呼び出し側が必ず渡す (空配列は「何も信頼しない」)。
 * `label` は呼び出し側が付ける snapshot の名前 (例: 配布した registry の版)。結果に写すだけで判定に使わない。
 */
export interface SpecTrustInput {
  label?: string;
  checkpointKeys: readonly CheckpointPublicKey[];
  examAuthorityKeys: readonly ExamAuthorityKey[];
}

export interface SpecVerificationContext {
  /** 既定は `full` (`verifyProofFile` と同じ)。`fast` は PoSW の再計算を省く */
  mode?: VerificationMode;
  trust: SpecTrustInput;
  /** 受理ポリシー (ADR-0043)。省略はすべての要件を立てない */
  policy?: AcceptancePolicy;
  /**
   * 評価時刻 (ISO 8601)。必須。結果の `evaluation.time` にそのまま写す。
   * legacy 1.2.0 の規則は評価時刻を判定に使わない (鍵の有効期間は証拠側の `serverTimestamp`・`issuedAt`・
   * `releaseTime` で判定する) ので、いまは記録だけ。隠れた時計 (`Date.now()`) に頼らないために入力で受ける。
   */
  evaluationTime: string;
  /**
   * 試験の問題パッケージ (`.tcexam` を JSON.parse した値)。入口が自分で `parseExamPackageManifest` と
   * `verifyExamBinding` にかける。呼び出し側が「束縛は検証済み」と申告する口は無い (ADR-0054 §1)。
   */
  examPackage?: unknown;
  /** 提出時刻 (epoch ms)。試験の time-box (advisory) に渡すだけ */
  submissionTimeMs?: number;
  onProgress?: VerificationProgressCallback;
}

/** 対応状況 */
export type SpecSupportStatus = 'supported' | 'unsupported' | 'malformed';

/** `support.code`。`supported` のときは付かない */
export type SpecSupportCode =
  /** 入力が object でない (null・配列・プリミティブ) */
  | 'not-an-object'
  /** legacy の識別子 `version` が無い */
  | 'version-missing'
  /** `version` が文字列でない、または `MAJOR.MINOR.PATCH` でない */
  | 'version-malformed'
  /** `version` は正しい形だが登録が無い (1.2.0 以外) */
  | 'version-not-registered'
  /** 新形式の識別子 (`kind` / `specVersion`) の形が不正、または片方しか無い */
  | 'kind-malformed'
  /** 新形式の識別子は正しい形だが登録が無い (#810 で登録する) */
  | 'kind-not-registered'
  /** 版は登録済みだが、その仕様の検証器に渡せる構造をしていない */
  | 'structure-invalid';

/**
 * 入力が名乗った識別子のうち、結果に載せてよいもの (shared/AGENTS.md 不変条件 11)。生の文字列は載せない:
 * `version` は厳密に parse できた数字から組み直した値、`kind` は決めた文字種に合う値、`specVersion` は整数だけ。
 */
export interface SpecDeclaredIdentifier {
  version?: string;
  kind?: string;
  specVersion?: number;
}

export interface SpecSupport {
  status: SpecSupportStatus;
  /** `supported` のときだけ付く */
  spec?: SpecId;
  declared?: SpecDeclaredIdentifier;
  code?: SpecSupportCode;
}

export type SpecCheckStatus = 'pass' | 'fail' | 'not-checked' | 'not-applicable';

export type SpecCheckCode =
  | 'typing-proof-hash-mismatch'
  | 'event-metadata-mismatch'
  | 'root-mismatch'
  | ChainFailureCode
  | 'final-hash-mismatch'
  | 'content-mismatch'
  | 'checkpoint-mismatch'
  /** 署名 cp の証拠が合わない (署名・連鎖・照合値) */
  | 'signed-checkpoint-invalid'
  /** 署名 cp の鍵を信頼できない (未登録・失効・期間外・registry のエントリ不正)。`trust.keys` に状態がある */
  | 'signed-checkpoint-key-untrusted'
  | RootAnchorFailureCode
  /** token と署名 cp の sessionId が食い違う (別セッションの token の流用) */
  | 'token-session-mismatch'
  /** 渡された問題パッケージが manifest として読めない */
  | 'exam-package-malformed'
  /** 出題者鍵を信頼できない。`trust.keys` に状態がある */
  | 'exam-authority-key-untrusted'
  /** 問題束縛の検査のどれかが合わない (内訳は `detail.examBinding`) */
  | 'exam-binding-invalid';

export interface SpecCheck {
  status: SpecCheckStatus;
  code?: SpecCheckCode;
}

export interface SpecChecks {
  /** 仕様の検証器に渡せる構造か (イベント配列の構造検査を含む) */
  structure: SpecCheck;
  /** `typingProofHash` と内容のハッシュ、メタデータの再カウント */
  metadata: SpecCheck;
  /** チェーンの root の再計算 (アンカー無し / sessionStartToken / exam v1 / exam v2) */
  root: SpecCheck;
  /** イベントの連結 (sequence・時刻・previousHash・反復数・hash) */
  chain: SpecCheck;
  /** PoSW の `intermediateHash` の再計算 */
  posw: SpecCheck;
  finalHash: SpecCheck;
  /** 内容の再生と `content` の一致 */
  content: SpecCheck;
  /** 未署名 cp の照合値 */
  checkpoints: SpecCheck;
  signedCheckpoints: SpecCheck;
  /** sessionStartToken による root のサーバアンカー (ADR-0017) */
  sessionAnchor: SpecCheck;
  /** 試験の問題パッケージへの束縛 (ADR-0006) */
  problemBinding: SpecCheck;
}

export type SpecLimitationCode =
  /** legacy 1.2.0 の `version` は `typingProofHash` の入力ではなく、証拠に束縛されていない */
  | 'legacy-spec-version-unbound'
  /** fast モードで PoSW を再計算していない (ADR-0031) */
  | 'posw-not-recomputed'
  /** exam の proof だが問題パッケージを渡されず、問題束縛を確かめていない */
  | 'problem-package-not-provided'
  /** 出題者鍵の有効期間を出題者の自己申告 (`releaseTime`) で判定している (system-spec §6.4 手順 1) */
  | 'exam-key-anchor-self-declared';

export type SpecKeyRole = 'checkpoint' | 'session-token' | 'exam-authority';

export interface SpecTrustedKey {
  role: SpecKeyRole;
  /** registry にある鍵は registry の値。未登録の鍵は決めた文字種に合うときだけ載せる */
  keyId?: string;
  status: RegistryKeyTrustStatus;
  /**
   * 判定に使った証拠側の時刻 (ISO 8601 に正規化。署名 cp は `serverTimestamp`、token は `issuedAt`、
   * 出題者鍵は `releaseTime`)。同じ鍵・同じ状態の署名 cp が複数あるときは最後のもの
   */
  anchor?: string;
}

export interface SpecTrustResult {
  snapshot: {
    label?: string;
    /** `{ checkpointKeys, examAuthorityKeys }` を `deterministicStringify` した SHA-256 (16 進) */
    digest: string;
  };
  keys: SpecTrustedKey[];
}

/**
 * 整合性。値の語彙は ADR-0020 / ADR-0031 と同じだが、`checks` だけから導く別の値:
 * どれかが `fail` なら `failed`、`fail` が無くどれかが `not-checked` なら `partial`、すべて `pass` か
 * `not-applicable` なら `proven`。`unsupported` / `malformed` では `not-evaluated`。
 * 鍵を信頼できない失敗・token の検証失敗・sessionId の不一致も `failed` になる (legacy の `integrityValid` より
 * 甘くしない)。`assurance.integrity` (署名 cp・token の失敗を時刻アンカー層に数える) とも、
 * `FullVerificationResult.integrityValid` (問題束縛を含まない) とも別 (system-spec §6.5.3)
 */
export type SpecIntegrity = IntegrityLevel | 'not-evaluated';

/**
 * legacy 1.2.0 の元の結果。**共通契約ではない** (仕様ごとに形が違い、#811 の公開型には入れない)。
 * 表示の移行期間に、既存の UI が読んでいる値を取り出すためだけに置く。
 */
export interface LegacyTypingProofDetail {
  legacyProof: FullVerificationResult;
  examBinding?: ExamBindingVerificationResult;
}

export interface SpecVerificationResult {
  resultSchema: typeof SPEC_RESULT_SCHEMA;
  support: SpecSupport;
  integrity: SpecIntegrity;
  checks: SpecChecks;
  limitations: SpecLimitationCode[];
  trust: SpecTrustResult;
  acceptance: AcceptancePolicyResult;
  evaluation: { time: string; mode: VerificationMode };
  detail?: LegacyTypingProofDetail;
}
