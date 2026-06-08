/**
 * 試験モード (ADR-0006) の **出題者オーサリング seam** — 平文問題から署名済み封印
 * パッケージ (`.tcexam`) を生成する純粋コア。
 *
 * 役割: editor アプリ内（将来の `/author` UI / 対話 CLI）が共有する「問題 → .tcexam」の
 * 単一導線。**暗号は一切再実装せず** shared の `buildExamPackage` /
 * `computeExamPackageHash` / `canonicalizeStartToken` を直接呼ぶ。これにより
 * `packages/workers/scripts/make-exam-package.mjs` が抱える canonical core / signing core の
 * 手写し複製 (= shared と必ず一致させる保守負債) を将来的に解消できる土台にする。
 *
 * 本モジュールは DOM 非依存・純関数。鍵・問題文・時刻はすべて引数で受け取り、UI 状態や
 * ストレージには触れない (テスト容易性と再利用性のため)。WebCrypto (`crypto.subtle` /
 * `crypto.getRandomValues`) のみに依存し、browser / Node (vitest) 双方で動く。
 */

import {
  buildExamPackage,
  computeExamPackageHash,
  canonicalizeStartToken,
  arrayBufferToHex,
  encodeExamBundle,
  EXAM_BUNDLE_SCHEMA,
  DEFAULT_EXAM_KDF_PARAMS,
  EXAM_PACKAGE_FORMAT_VERSION,
  type ExamKdf,
  type ExamKdfParams,
  type ExamPackageBuildInput,
  type ExamPackageManifest,
  type ExamPackageSigner,
  type ExamBundle,
  type ExamBundleProblem,
} from '@typedcode/shared';

/** Crockford Base32 アルファベット (I L O U を除外 = 32 文字)。監督コード生成に使う。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 監督コードの既定長 (文字数)。8 字 Crockford = 40 bit のエントロピー。 */
export const DEFAULT_PROCTOR_TOKEN_LENGTH = 8;

/** release → deadline の既定ウィンドウ (3 時間)。deadline 未指定時に release から算出。 */
export const DEFAULT_EXAM_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * 暗号学的乱数で Crockford Base32 の監督コードを生成する。
 * `256 % 32 === 0` なのでモジュロバイアスは無い。返り値は既に正準形 (大文字・区切り無し)。
 */
export function generateProctorToken(length: number = DEFAULT_PROCTOR_TOKEN_LENGTH): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('Proctor token length must be a positive integer');
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CROCKFORD[bytes[i]! % 32];
  }
  return out;
}

/**
 * 監督コードをスライド掲示用に 4 文字ごとへグルーピングする (`ABCD-EFGH`)。
 * 表示専用。KDF / root / proof 保存には必ず正準形 (`canonicalizeStartToken`) を使う。
 */
export function formatProctorTokenForDisplay(token: string): string {
  const canonical = canonicalizeStartToken(token);
  return canonical.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * 出題者の私的 JWK を WebCrypto 署名鍵に取り込み、`buildExamPackage` 用の signer を作る。
 * `embedPublicKey` を立てると long-term verifiability 用に公開鍵 (`{kty,crv,x,y}`) を
 * manifest 同梱できる (信頼源は常に registry。同梱鍵は控え)。
 */
export async function importAuthoritySigner(
  jwk: JsonWebKey | string,
  keyId: string,
  options: { embedPublicKey?: boolean } = {}
): Promise<ExamPackageSigner> {
  if (!keyId) {
    throw new Error('keyId is required');
  }
  let parsed: JsonWebKey;
  try {
    parsed = typeof jwk === 'string' ? (JSON.parse(jwk) as JsonWebKey) : jwk;
  } catch {
    throw new Error('Signing key JWK is not valid JSON');
  }
  if (!parsed || parsed.kty !== 'EC' || parsed.crv !== 'P-256' || !parsed.d) {
    throw new Error('Signing key must be an EC P-256 private JWK (with a "d" parameter)');
  }

  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      'jwk',
      parsed,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
  } catch {
    throw new Error('Failed to import signing key (malformed P-256 private JWK)');
  }

  const signer: ExamPackageSigner = { keyId, privateKey };
  if (options.embedPublicKey) {
    // 公開成分のみを抽出 (秘密スカラ d は同梱しない)。
    signer.publicKeyJwk = { kty: parsed.kty, crv: parsed.crv, x: parsed.x, y: parsed.y };
  }
  return signer;
}

/** `createExamPackage` の入力。時刻は ISO 文字列、言語は許可リスト。 */
export interface CreateExamPackageParams {
  /** 平文の問題本文 (Markdown 想定)。封印される。 */
  problemText: string;
  examId: string;
  problemId: string;
  /** per-student variant。単一問題運用は null。 */
  variant?: string | null;
  /** 許可言語 (空白除去・空要素除去してから封印)。 */
  languages: string[];
  /** 試験開始 T0 (ISO)。 */
  releaseTime: string;
  /** 提出期限 T1 (ISO)。 */
  deadline: string;
  /** 監督コード。生・区切り入りでも可 (内部で正準化)。 */
  proctorToken: string;
  /** Argon2id パラメータ。既定は ADR-0006 の 64MiB/3iters/1lane。 */
  kdfParams?: ExamKdfParams;
}

/** `createExamPackage` の結果。manifest + 確認用 packageHash + 実際に使った正準監督コード。 */
export interface CreatedExamPackage {
  manifest: ExamPackageManifest;
  /** SHA-256(canonical core)。proof.exam.packageHash と突合する確認値。 */
  packageHash: string;
  /** KDF/復号に実際に使われた正準形の監督コード (T0 に解禁する値)。 */
  proctorToken: string;
}

/**
 * 平文問題を封印して署名済み `.tcexam` manifest を作る (オーサリングの単一導線)。
 * salt / IV は毎回ランダム生成し、暗号・署名・packageHash はすべて shared に委譲する。
 *
 * @throws 入力が不正 (空の問題文 / 言語なし / 時刻不正 / release ≥ deadline / 空の監督コード) なとき。
 */
export async function createExamPackage(
  params: CreateExamPackageParams,
  signer: ExamPackageSigner
): Promise<CreatedExamPackage> {
  const problemText = params.problemText;
  if (!problemText || problemText.length === 0) {
    throw new Error('problemText must not be empty');
  }
  if (!params.examId || !params.problemId) {
    throw new Error('examId and problemId are required');
  }

  const languages = params.languages.map((l) => l.trim()).filter((l) => l.length > 0);
  if (languages.length === 0) {
    throw new Error('At least one allowed language is required');
  }

  const releaseMs = Date.parse(params.releaseTime);
  const deadlineMs = Date.parse(params.deadline);
  if (!Number.isFinite(releaseMs)) {
    throw new Error('releaseTime is not a valid ISO date');
  }
  if (!Number.isFinite(deadlineMs)) {
    throw new Error('deadline is not a valid ISO date');
  }
  if (releaseMs >= deadlineMs) {
    throw new Error('releaseTime must be strictly before deadline');
  }

  const proctorToken = canonicalizeStartToken(params.proctorToken);
  if (proctorToken.length === 0) {
    throw new Error('proctorToken must contain at least one Crockford Base32 character');
  }

  // salt は毎回ランダム 16 byte (KDF 出力をパッケージ間で非相関にする)。
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const kdf: ExamKdf = {
    algorithm: 'argon2id',
    salt: arrayBufferToHex(salt),
    params: params.kdfParams ?? { ...DEFAULT_EXAM_KDF_PARAMS },
  };

  const input: ExamPackageBuildInput = {
    formatVersion: EXAM_PACKAGE_FORMAT_VERSION,
    examId: params.examId,
    problemId: params.problemId,
    variant: params.variant ?? null,
    kdf,
    releaseTime: params.releaseTime,
    deadline: params.deadline,
    allowed: { languages },
    keyId: signer.keyId,
    algorithm: 'ECDSA-P256',
  };

  const manifest = await buildExamPackage(input, problemText, proctorToken, signer);
  const packageHash = await computeExamPackageHash(manifest);
  return { manifest, packageHash, proctorToken };
}

/** `createExamBundlePackage` の入力。1つの `.tcexam` に N 問をバンドルする (ADR-0012)。 */
export interface CreateExamBundleParams {
  examId: string;
  /** N 問。各問: problemId + statement + 任意の starter (単一ファイル)。 */
  problems: ExamBundleProblem[];
  /** 許可言語 (グローバル allow-list)。 */
  languages: string[];
  releaseTime: string;
  deadline: string;
  proctorToken: string;
  kdfParams?: ExamKdfParams;
}

/**
 * N問バンドル (`tcexam-exam/1`) を封印して署名済み `.tcexam` を作る (ADR-0012)。
 * 平文は `encodeExamBundle` で組み立て、封印・署名・packageHash は `createExamPackage` に委譲する
 * (= 単一導線の再利用)。manifest.problemId はバンドルラベル `'bundle'`、個々の problemId は平文内。
 *
 * @throws 問題が空 / problemId 重複・空 / statement 空 / starter 不備、および createExamPackage の検証。
 */
export async function createExamBundlePackage(
  params: CreateExamBundleParams,
  signer: ExamPackageSigner
): Promise<CreatedExamPackage> {
  if (!params.problems || params.problems.length === 0) {
    throw new Error('At least one problem is required');
  }
  const seen = new Set<string>();
  const problems: ExamBundleProblem[] = [];
  for (const p of params.problems) {
    const problemId = p.problemId.trim();
    if (!problemId) throw new Error('Each problem needs a problemId');
    if (seen.has(problemId)) throw new Error(`Duplicate problemId: ${problemId}`);
    seen.add(problemId);
    if (!p.statement || p.statement.trim().length === 0) {
      throw new Error(`Problem "${problemId}" has an empty statement`);
    }
    const cleaned: ExamBundleProblem = { problemId, statement: p.statement };
    if (p.starter && p.starter.content.length > 0) {
      const filename = p.starter.filename.trim();
      const language = p.starter.language.trim();
      if (!filename || !language) {
        throw new Error(`Problem "${problemId}" starter needs a filename and language`);
      }
      cleaned.starter = { filename, language, content: p.starter.content };
    }
    problems.push(cleaned);
  }

  const bundle: ExamBundle = { schema: EXAM_BUNDLE_SCHEMA, problems };
  return createExamPackage(
    {
      problemText: encodeExamBundle(bundle),
      examId: params.examId,
      problemId: 'bundle',
      variant: null,
      languages: params.languages,
      releaseTime: params.releaseTime,
      deadline: params.deadline,
      proctorToken: params.proctorToken,
      kdfParams: params.kdfParams,
    },
    signer
  );
}
