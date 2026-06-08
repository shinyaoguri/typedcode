/**
 * 試験モード (ADR-0006) の暗号コア — 封印問題パッケージ (`*.tcexam`) と
 * 監督コードによるチェーン根束縛。
 *
 * 役割:
 * - `buildExamPackage`: 平文問題を Argon2id KDF + AES-256-GCM で封印し ECDSA-P256 署名する
 *   (出題者ツール / テストの単一真実源)
 * - `verifyExamPackageSignature`: 出題者鍵レジストリで package 署名を検証する
 * - `deriveExamKey` / `decryptExamPackage`: 監督コードから鍵を導出し復号する
 * - `computeExamPackageHash` / `computeProblemContentHash` / `computeExamChainRoot`: 束縛用ハッシュ
 * - `verifyExamBinding`: grader 用の高レベル検証 (署名 → packageHash → root → 内容ハッシュ → time-box)
 *
 * 不変条件: **署名入力と packageHash は同一の canonical core** (`{signature, publicKeyJwk}` を
 * 除いた manifest) を `deterministicStringify` して計算する。これにより任意同梱の publicKeyJwk の
 * 有無や署名値そのものに packageHash が依存しない。
 *
 * このモジュールは browser / Node 両方で動く (DOM 非依存)。Argon2id は純 JS の
 * `@noble/hashes/argon2` を使い、AES-GCM / ECDSA は WebCrypto を使う。
 */

import { argon2id } from '@noble/hashes/argon2.js';
import type {
  ExamPackageManifest,
  ExamPackageSigningCore,
  ExamKdf,
  ExamProofBlock,
  ExamSessionContext,
} from '../types/exam.js';
import type { ExportedProof } from '../types/proof.js';
import { computeHash, deterministicStringify, arrayBufferToHex } from '../utils/hashUtils.js';
import {
  EXAM_AUTHORITY_KEYS,
  findExamAuthorityKey,
  type ExamAuthorityKey,
} from '../examAuthorityKeys/index.js';
import { EXAM_PACKAGE_FORMAT_VERSION, EXAM_PROOF_VERSION, EXAM_ROOT_BINDING } from '../version.js';

// ============================================================================
// バイト列ユーティリティ (DOM/Node 非依存)
// ============================================================================

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Invalid hex string');
    out[i] = byte;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** WebCrypto に Uint8Array をそのまま渡すための型合わせ */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ============================================================================
// 監督コードの正準化
// ============================================================================

/** Crockford Base32 で許される文字 (I L O U を除外) */
const CROCKFORD_ALLOWED = /[^0-9A-HJKMNP-TV-Z]/g;

/**
 * 監督コードを正準形 (大文字・区切り除去) に正規化する。スライド表示用の
 * グルーピング (`ABCD-EFGH`) や空白・小文字を吸収する。**KDF / root / proof 保存の
 * いずれにも、必ずこの正準形を使うこと** (経路間で一致しないと復号 or root 検証が失敗する)。
 */
export function canonicalizeStartToken(raw: string): string {
  return raw.toUpperCase().replace(CROCKFORD_ALLOWED, '');
}

// ============================================================================
// manifest パース / バリデーション (untrusted JSON → ExamPackageManifest)
// ============================================================================

/**
 * untrusted な JSON (`.tcexam` ファイル) を ExamPackageManifest として最低限の構造検証つきで
 * パースする。形が不正なら null。真正性は `verifyExamPackageSignature`、復号可否は
 * `decryptExamPackage` が担う (ここは「形が揃っているか」だけを見る)。editor の取込ゲートと
 * verify-cli / verify(web) の grader が同じ判定を共有するために shared に置く。
 */
export function parseExamPackageManifest(input: unknown): ExamPackageManifest | null {
  if (!input || typeof input !== 'object') return null;
  const m = input as Record<string, unknown>;
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

  if (typeof m.formatVersion !== 'number') return null;
  if (!isStr(m.examId) || !isStr(m.problemId)) return null;
  if (!(m.variant === null || isStr(m.variant))) return null;
  if (!isStr(m.releaseTime) || !isStr(m.deadline)) return null;
  if (!isStr(m.keyId) || !isStr(m.algorithm) || !isStr(m.signature)) return null;

  const kdf = m.kdf;
  if (!isObj(kdf) || kdf.algorithm !== 'argon2id' || !isStr(kdf.salt) || !isObj(kdf.params)) return null;
  const p = kdf.params;
  if (
    typeof p.memKiB !== 'number' ||
    typeof p.iterations !== 'number' ||
    typeof p.parallelism !== 'number'
  ) {
    return null;
  }

  const cipher = m.cipher;
  if (
    !isObj(cipher) ||
    cipher.algorithm !== 'AES-256-GCM' ||
    !isStr(cipher.iv) ||
    !isStr(cipher.ciphertext)
  ) {
    return null;
  }

  const allowed = m.allowed;
  if (!isObj(allowed) || !Array.isArray(allowed.languages)) return null;
  if (!allowed.languages.every((l) => typeof l === 'string')) return null;

  // publicKeyJwk は任意 (long-term verifiability の同梱)。あれば object。
  if (m.publicKeyJwk !== undefined && !isObj(m.publicKeyJwk)) return null;

  return input as ExamPackageManifest;
}

// ============================================================================
// canonical core / ハッシュ
// ============================================================================

/**
 * `{signature, publicKeyJwk}` を除いた manifest の canonical core。
 * 署名入力と packageHash の双方がこの core を `deterministicStringify` して計算する。
 * 新フィールドを manifest に足すときは**ここにも明示的に足す** (root に焼かれる対象を明確にするため)。
 */
export function examPackageSigningCore(manifest: ExamPackageManifest): ExamPackageSigningCore {
  return {
    formatVersion: manifest.formatVersion,
    examId: manifest.examId,
    problemId: manifest.problemId,
    variant: manifest.variant,
    kdf: manifest.kdf,
    cipher: manifest.cipher,
    releaseTime: manifest.releaseTime,
    deadline: manifest.deadline,
    allowed: manifest.allowed,
    keyId: manifest.keyId,
    algorithm: manifest.algorithm,
  };
}

/** packageHash = SHA-256(deterministicStringify(signing core)) */
export async function computeExamPackageHash(manifest: ExamPackageManifest): Promise<string> {
  return computeHash(deterministicStringify(examPackageSigningCore(manifest)));
}

/** 復号後**平文**問題の SHA-256 */
export async function computeProblemContentHash(plaintext: string): Promise<string> {
  return computeHash(plaintext);
}

/**
 * exam モードのチェーン根 (genesis = 監督コード入力 = T0)。editor と verifier 共有の唯一の root ヘルパ。
 *
 * - **v1** (単一問題、ADR-0006): root = SHA-256(fingerprintHash ‖ localNonce ‖ packageHash ‖ startToken)。
 * - **v2** (N問バンドル、ADR-0012 B-2): 末尾に per-problem `problemContentHash` を連結し、
 *   各タブの genesis を「この封印の・この問題」に束縛する。
 *   root = SHA-256(… ‖ startToken ‖ problemContentHash)。
 *
 * `problemContentHash` 省略時は **v1 とバイト一致**する (後方互換)。各値は固定長 hex /
 * Crockford トークンなので連結の境界は曖昧にならない (startToken は大文字 Crockford、
 * problemContentHash は小文字 hex で、同じ連結は同じ (token, hash) からしか生じない)。
 */
export async function computeExamChainRoot(
  fingerprintHash: string,
  localNonce: string,
  packageHash: string,
  startToken: string,
  problemContentHash?: string
): Promise<string> {
  const suffix = problemContentHash ?? '';
  return computeHash(fingerprintHash + localNonce + packageHash + startToken + suffix);
}

// ============================================================================
// KDF / 復号 / 暗号化
// ============================================================================

/**
 * 監督コードから 32 byte の鍵を Argon2id で導出する。
 * salt / params は manifest.kdf。**startToken は正準形を渡すこと**。
 */
export function deriveExamKey(startToken: string, kdf: ExamKdf): Uint8Array {
  const password = new TextEncoder().encode(startToken);
  const salt = hexToBytes(kdf.salt);
  return argon2id(password, salt, {
    t: kdf.params.iterations,
    m: kdf.params.memKiB,
    p: kdf.params.parallelism,
    dkLen: 32,
  });
}

export type ExamDecryptResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: string };

/**
 * 監督コードで package を復号する。誤コードは AES-GCM の認証タグで弾かれる
 * (平文に token のコミットメントは置かない = ADR)。**startToken は正準形を渡すこと**。
 */
export async function decryptExamPackage(
  manifest: ExamPackageManifest,
  startToken: string
): Promise<ExamDecryptResult> {
  if (manifest.cipher.algorithm !== 'AES-256-GCM') {
    return { ok: false, reason: `Unsupported cipher: ${manifest.cipher.algorithm}` };
  }
  if (manifest.kdf.algorithm !== 'argon2id') {
    return { ok: false, reason: `Unsupported KDF: ${manifest.kdf.algorithm}` };
  }
  let plaintext: string;
  try {
    const keyBytes = deriveExamKey(startToken, manifest.kdf);
    const key = await crypto.subtle.importKey(
      'raw',
      asArrayBuffer(keyBytes),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );
    const iv = hexToBytes(manifest.cipher.iv);
    const ciphertext = base64ToBytes(manifest.cipher.ciphertext);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asArrayBuffer(iv) },
      key,
      asArrayBuffer(ciphertext)
    );
    plaintext = new TextDecoder().decode(decrypted);
  } catch {
    // GCM 認証失敗 (誤コード) や hex/base64 不正を一律「復号失敗」に畳む
    return { ok: false, reason: 'Decryption failed (wrong proctor code or corrupted package)' };
  }
  return { ok: true, plaintext };
}

// ============================================================================
// package のビルド (出題者ツール / テスト)
// ============================================================================

export interface ExamPackageSigner {
  keyId: string;
  privateKey: CryptoKey;
  /** 任意で同梱する公開鍵 (long-term verifiability) */
  publicKeyJwk?: JsonWebKey;
}

/** build に渡す入力 = manifest から build が決める {cipher, signature, publicKeyJwk} を除いたもの */
export type ExamPackageBuildInput = Omit<ExamPackageSigningCore, 'cipher'>;

/**
 * 平文問題を封印して署名済み `.tcexam` manifest を作る。
 * editor (復号) / grader (検証) とパリティを保つための単一真実源。
 * **startToken は正準形を渡すこと**。
 */
export async function buildExamPackage(
  input: ExamPackageBuildInput,
  plaintext: string,
  startToken: string,
  signer: ExamPackageSigner
): Promise<ExamPackageManifest> {
  // 1. KDF で鍵導出
  const keyBytes = deriveExamKey(startToken, input.kdf);
  const key = await crypto.subtle.importKey(
    'raw',
    asArrayBuffer(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // 2. AES-256-GCM 暗号化 (IV は毎回ランダム 12 byte)
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv) },
    key,
    asArrayBuffer(new TextEncoder().encode(plaintext))
  );

  // 3. canonical core を組み立て
  const core: ExamPackageSigningCore = {
    formatVersion: input.formatVersion,
    examId: input.examId,
    problemId: input.problemId,
    variant: input.variant,
    kdf: input.kdf,
    cipher: {
      algorithm: 'AES-256-GCM',
      iv: arrayBufferToHex(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    },
    releaseTime: input.releaseTime,
    deadline: input.deadline,
    allowed: input.allowed,
    keyId: signer.keyId,
    algorithm: input.algorithm,
  };

  // 4. canonical core を ECDSA-P256 署名
  const signingInput = new TextEncoder().encode(deterministicStringify(core));
  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer.privateKey,
    asArrayBuffer(new Uint8Array(signingInput))
  );

  const manifest: ExamPackageManifest = {
    ...core,
    signature: arrayBufferToHex(sigBuffer),
  };
  if (signer.publicKeyJwk) manifest.publicKeyJwk = signer.publicKeyJwk;
  return manifest;
}

// ============================================================================
// 署名検証
// ============================================================================

export interface ExamPackageSignatureResult {
  valid: boolean;
  reason?: string;
  registryEntry?: ExamAuthorityKey | null;
  /** trust はするが注意を要する場合の警告 (例: 失効前に署名された package を時刻で trust) */
  warning?: string;
}

/**
 * 出題者鍵レジストリで package 署名を検証する (ADR-0006)。
 *
 * **信頼アンカーは常に registry**。keyId が registry に解決できない鍵は信頼しない:
 *   - 同梱 `publicKeyJwk` は long-term verifiability 用の控えであって信頼の源ではない。
 *     これを信頼源にすると攻撃者が自分の鍵を同梱して自己署名でき (出題者署名の意味が消える)。
 *     よって registry 未登録の埋め込み鍵は untrusted として弾き、registry にある場合のみ
 *     JWK 一致を必須にする (すり替え検出)。署名は常に registry の公開鍵で検証する。
 *   - 鍵の有効期間 / 失効は package の `releaseTime` (= 出題者が署名・配布した時点の代理) で
 *     判定する。signedCheckpoints のキー有効性判定と同型だが、checkpoint は server 署名時刻
 *     (信頼できる) を anchor にするのに対し exam は releaseTime (出題者の自己申告)。よって鍵漏洩
 *     時に releaseTime を遡らせれば失効/期限切れ判定を回避し得る — 完全な失効には独立した信頼
 *     時刻 (proof の署名 cp の serverTimestamp 等) が要る (将来課題)。ここでは正直に申告された
 *     鍵の期限切れ/失効を弾く defense-in-depth に留める。
 */
export async function verifyExamPackageSignature(
  manifest: ExamPackageManifest,
  registry: readonly ExamAuthorityKey[] = EXAM_AUTHORITY_KEYS
): Promise<ExamPackageSignatureResult> {
  if (manifest.algorithm !== 'ECDSA-P256') {
    return { valid: false, reason: `Unsupported algorithm: ${manifest.algorithm}` };
  }

  // 信頼アンカーは registry。未登録 keyId は (埋め込み鍵があっても) 信頼しない。
  const registryEntry = findExamAuthorityKey(manifest.keyId, registry) ?? null;
  if (!registryEntry) {
    return { valid: false, reason: `Unknown keyId: ${manifest.keyId}`, registryEntry: null };
  }

  // 同梱 publicKeyJwk があれば registry エントリと一致必須 (埋め込み鍵すり替えの検出)。
  if (manifest.publicKeyJwk) {
    const sameJwk =
      deterministicStringify(manifest.publicKeyJwk) ===
      deterministicStringify(registryEntry.publicKeyJwk);
    if (!sameJwk) {
      return { valid: false, reason: 'Embedded public key does not match registry entry', registryEntry };
    }
  }

  // 鍵の有効期間 / 失効を releaseTime で判定 (期限切れ・失効鍵での署名を弾く)。
  const validity = checkExamKeyValidityAtRelease(registryEntry, manifest.releaseTime);
  if (!validity.ok) {
    return { valid: false, reason: validity.reason, registryEntry };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(manifest.signature);
  } catch {
    return { valid: false, reason: 'Malformed signature hex', registryEntry };
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      registryEntry.publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
  } catch {
    return { valid: false, reason: 'Invalid public key', registryEntry };
  }

  const signingInput = new TextEncoder().encode(deterministicStringify(examPackageSigningCore(manifest)));

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      asArrayBuffer(signatureBytes),
      asArrayBuffer(new Uint8Array(signingInput))
    );
  } catch {
    return { valid: false, reason: 'Signature verification error', registryEntry };
  }

  if (!valid) {
    return { valid: false, registryEntry };
  }
  return { valid: true, registryEntry, warning: validity.warning };
}

/**
 * 出題者鍵が package の `releaseTime` 時点で有効かを判定する (ADR-0006)。
 * signedCheckpoints のキー有効性判定をミラー (anchor が serverTimestamp ではなく releaseTime)。
 *   - validFrom より前 / validUntil より後の release → 期限外で reject
 *   - revokedAt 以降の release → 失効後署名で reject、revokedAt より前 → trust + warning
 *   - status='revoked' で revokedAt 無し → 安全側で reject
 */
function checkExamKeyValidityAtRelease(
  entry: ExamAuthorityKey,
  releaseTime: string
): { ok: true; warning?: string } | { ok: false; reason: string } {
  const releaseTs = Date.parse(releaseTime);
  if (!Number.isFinite(releaseTs)) {
    return { ok: false, reason: 'Package releaseTime is not a valid date' };
  }
  const fromTs = Date.parse(entry.validFrom);
  if (Number.isFinite(fromTs) && releaseTs < fromTs) {
    return { ok: false, reason: `Authority key ${entry.keyId} was not yet valid at package release time` };
  }
  if (entry.validUntil) {
    const untilTs = Date.parse(entry.validUntil);
    if (Number.isFinite(untilTs) && releaseTs > untilTs) {
      return { ok: false, reason: `Authority key ${entry.keyId} had expired by package release time` };
    }
  }
  if (entry.revokedAt) {
    const revokedTs = Date.parse(entry.revokedAt);
    if (Number.isFinite(revokedTs) && releaseTs >= revokedTs) {
      return { ok: false, reason: `Authority key ${entry.keyId} was revoked at or before package release time` };
    }
    // 失効前に署名された package は trust するが警告 (registry の運用方針)。
    return { ok: true, warning: `Authority key ${entry.keyId} was revoked after this package was released` };
  }
  if (entry.status === 'revoked') {
    // revokedAt が無いまま status='revoked' は安全側で reject (signedCheckpoints と同方針)。
    return { ok: false, reason: `Authority key ${entry.keyId} is revoked (status) without revokedAt` };
  }
  return { ok: true };
}

// ============================================================================
// grader 用の高レベル束縛検証 (ADR-0006 §5)
// ============================================================================

export interface ExamTimeBox {
  releaseTime: string;
  deadline: string;
  /** releaseTime < deadline か (window が成立するか) */
  windowCoherent: boolean;
  /** submissionTime が [releaseTime, deadline] 内か。submissionTime 未提供なら null (外部=Moodle 提出時刻で確定) */
  withinWindow: boolean | null;
}

export interface ExamBindingVerificationResult {
  /** 全ステップ合格か */
  valid: boolean;
  /** package 署名が本物の出題者鍵で検証できたか */
  packageSignatureValid: boolean;
  /** 再計算した packageHash が proof.exam.packageHash と一致するか */
  packageHashMatches: boolean;
  /** 監督コードから再計算した root が proof の initialEventChainHash と一致するか */
  rootMatches: boolean;
  /** 復号した平文の SHA-256 が proof.exam.problemContentHash と一致するか */
  problemContentHashMatches: boolean;
  /** 時間窓 (advisory)。submission 時刻が無い PR1 では withinWindow=null */
  timeBox: ExamTimeBox | null;
  reason?: string;
  /** trust はするが注意を要する警告 (例: 失効前に署名された package を時刻で trust) */
  warning?: string;
  registryEntry?: ExamAuthorityKey | null;
}

export interface VerifyExamBindingOptions {
  /** 出題者鍵レジストリ (テスト/CLI から注入) */
  examAuthorityRegistry?: readonly ExamAuthorityKey[];
  /** Moodle 提出時刻 (epoch ms)。time-box の withinWindow 判定に使う。未提供なら null */
  submissionTimeMs?: number;
}

/**
 * proof と封印 package から「この答案が、この問題に、T0 以降に紐づく」ことを検証する (ADR-0006 §5)。
 * チェーン / PoSW / 署名 cp の検証は verifyProofFile が別途担う (本関数は exam 束縛のみ)。
 */
export async function verifyExamBinding(
  proof: Pick<ExportedProof, 'exam' | 'typingProofData' | 'fingerprint'>,
  manifest: ExamPackageManifest,
  options: VerifyExamBindingOptions = {}
): Promise<ExamBindingVerificationResult> {
  const base: ExamBindingVerificationResult = {
    valid: false,
    packageSignatureValid: false,
    packageHashMatches: false,
    rootMatches: false,
    problemContentHashMatches: false,
    timeBox: null,
  };

  const exam = proof.exam;
  if (!exam) {
    return { ...base, reason: 'Proof has no exam block' };
  }
  const fingerprintHash = proof.fingerprint?.hash;
  const nonce = proof.typingProofData.initialHashNonce;
  const expectedRoot = proof.typingProofData.initialEventChainHash;
  if (!fingerprintHash || !nonce || !expectedRoot) {
    return { ...base, reason: 'Proof is missing fingerprint hash, nonce, or initial chain hash' };
  }

  // 1. package 署名 → 本物の問題
  const sig = await verifyExamPackageSignature(manifest, options.examAuthorityRegistry);
  const result: ExamBindingVerificationResult = {
    ...base,
    packageSignatureValid: sig.valid,
    warning: sig.warning,
    registryEntry: sig.registryEntry ?? null,
  };
  if (!sig.valid) {
    return { ...result, reason: sig.reason ?? 'Package signature invalid' };
  }

  // 2. packageHash 再計算 = proof.exam.packageHash → この問題に束縛
  const packageHash = await computeExamPackageHash(manifest);
  result.packageHashMatches = packageHash === exam.packageHash;
  if (!result.packageHashMatches) {
    return { ...result, reason: 'Recomputed packageHash does not match proof.exam.packageHash' };
  }

  // 3. root 再計算 (fp, nonce, packageHash, startToken) = initialEventChainHash → T0 以降に開始
  const recomputedRoot = await computeExamChainRoot(fingerprintHash, nonce, packageHash, exam.startToken);
  result.rootMatches = recomputedRoot === expectedRoot;
  if (!result.rootMatches) {
    return { ...result, reason: 'Recomputed exam chain root does not match proof initialEventChainHash' };
  }

  // 4. startToken で復号 → 平文 SHA-256 = proof.exam.problemContentHash → 答案はこの問題のもの
  const decrypted = await decryptExamPackage(manifest, exam.startToken);
  if (!decrypted.ok) {
    return { ...result, reason: `Decryption failed: ${decrypted.reason}` };
  }
  const contentHash = await computeProblemContentHash(decrypted.plaintext);
  result.problemContentHashMatches = contentHash === exam.problemContentHash;
  if (!result.problemContentHashMatches) {
    return { ...result, reason: 'Decrypted problemContentHash does not match proof.exam.problemContentHash' };
  }

  // 6. time-box (advisory)。実際の submission 時刻は外部 (Moodle)。
  const releaseMs = Date.parse(manifest.releaseTime);
  const deadlineMs = Date.parse(manifest.deadline);
  const windowCoherent = Number.isFinite(releaseMs) && Number.isFinite(deadlineMs) && releaseMs < deadlineMs;
  let withinWindow: boolean | null = null;
  if (options.submissionTimeMs !== undefined && windowCoherent) {
    withinWindow = options.submissionTimeMs >= releaseMs && options.submissionTimeMs <= deadlineMs;
  }
  result.timeBox = {
    releaseTime: manifest.releaseTime,
    deadline: manifest.deadline,
    windowCoherent,
    withinWindow,
  };

  result.valid =
    result.packageSignatureValid &&
    result.packageHashMatches &&
    result.rootMatches &&
    result.problemContentHashMatches &&
    withinWindow !== false; // submission 提供時のみ window 違反で fail
  return result;
}

// ============================================================================
// proof.exam ブロックの組み立て (editor / テストから使う)
// ============================================================================

/** proof の exam ブロックを既定の version / rootBinding で組み立てる入力 (= 永続化される束縛コンテキスト) */
export type BuildExamProofBlockInput = ExamSessionContext;

/** proof の exam ブロックを既定の version / rootBinding で組み立てる */
export function buildExamProofBlock(input: BuildExamProofBlockInput): ExamProofBlock {
  return {
    examProofVersion: EXAM_PROOF_VERSION,
    examId: input.examId,
    problemId: input.problemId,
    variant: input.variant,
    packageHash: input.packageHash,
    problemContentHash: input.problemContentHash,
    startToken: input.startToken,
    rootBinding: EXAM_ROOT_BINDING,
  };
}

/** 既定の Argon2id KDF パラメータ (ADR-0006 §1)。64 MiB / 3 iters / 1 lane */
export const DEFAULT_EXAM_KDF_PARAMS = { memKiB: 65536, iterations: 3, parallelism: 1 } as const;

/** package フォーマットバージョン定数の再エクスポート (生成ツール用) */
export { EXAM_PACKAGE_FORMAT_VERSION };
