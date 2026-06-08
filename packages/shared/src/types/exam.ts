/**
 * 試験モード (ADR-0006) の型定義
 *
 * - `ExamPackageManifest`: 配布される封印問題パッケージ (`*.tcexam`, JSON)。平文メタ +
 *   Argon2id KDF パラメータ + AES-256-GCM 暗号文 + ECDSA-P256 署名。
 * - `ExamProofBlock`: エクスポートされる proof の `exam` ブロック (exam モード時のみ)。
 *
 * イベントデータ (`ExamOpenedEventData`) は他のイベント型に合わせて `events.ts` に置く。
 */

import type { SignedCheckpointAlgorithm } from './signedCheckpoint.js';
import type { TemplateFileDefinition } from './template.js';

/** Argon2id KDF パラメータ */
export interface ExamKdfParams {
  /** メモリコスト (KiB)。ADR 既定 65536 = 64 MiB */
  memKiB: number;
  /** 反復回数 (time cost)。ADR 既定 3 */
  iterations: number;
  /** 並列度 (lanes)。ADR 既定 1 */
  parallelism: number;
}

/** 鍵導出関数の記述 (現状 argon2id のみ) */
export interface ExamKdf {
  algorithm: 'argon2id';
  /** ソルト (hex, 16 bytes) */
  salt: string;
  params: ExamKdfParams;
}

/** 認証付き暗号 (現状 AES-256-GCM のみ) */
export interface ExamCipher {
  algorithm: 'AES-256-GCM';
  /** 初期化ベクトル (hex, 12 bytes) */
  iv: string;
  /** 暗号文 + GCM 認証タグ (base64) */
  ciphertext: string;
}

/**
 * 封印問題パッケージ (`*.tcexam`)。平文メタ + 暗号化問題 + 署名 (ADR-0006 §1)。
 *
 * `signature` は **`{signature, publicKeyJwk}` を除いた canonical core** に対する
 * ECDSA-P256 署名 (暗号文を含む全体にかかる)。`packageHash` も同じ core から計算する。
 */
export interface ExamPackageManifest {
  /** パッケージフォーマットバージョン */
  formatVersion: number;
  examId: string;
  problemId: string;
  /** per-student variant。v1 運用は単一問題 (null) */
  variant: string | null;
  kdf: ExamKdf;
  cipher: ExamCipher;
  /** 試験開始 (T0) の ISO 時刻 */
  releaseTime: string;
  /** 提出期限 (T1) の ISO 時刻 */
  deadline: string;
  allowed: { languages: string[] };
  keyId: string;
  algorithm: SignedCheckpointAlgorithm;
  /** 任意同梱の公開鍵 (long-term verifiability)。署名/packageHash の対象外 */
  publicKeyJwk?: JsonWebKey;
  /** canonical core に対する署名 (hex) */
  signature: string;
}

/**
 * `{signature, publicKeyJwk}` を除いた manifest の canonical core。
 * 署名入力と `packageHash` の双方がこの core を `deterministicStringify` して計算する。
 */
export type ExamPackageSigningCore = Omit<ExamPackageManifest, 'signature' | 'publicKeyJwk'>;

/**
 * 復号で確定する試験セッションの束縛コンテキスト。`TypingProof` が保持し、リロードを跨いで
 * 永続化され、`exportProof` で `ExamProofBlock` を組み立てるのに使う。startToken は正準形。
 */
export interface ExamSessionContext {
  examId: string;
  problemId: string;
  variant: string | null;
  /** SHA-256(deterministicStringify(signing core)) */
  packageHash: string;
  /**
   * 内容ハッシュ。v1(単一問題)は復号後平文全体の SHA-256、
   * v2(N問バンドル, ADR-0012)は per-problem の `computeBundleProblemHash`。
   */
  problemContentHash: string;
  /** 監督コード (正準形) */
  startToken: string;
  /**
   * root 束縛バージョン (ADR-0012)。`'v2'` のとき root に problemContentHash を連結する。
   * 省略/`'v1'` は単一問題 (ADR-0006) で従来どおり。
   */
  rootBinding?: string;
}

// ============================================================================
// 封印平文の構造化版 — N問バンドル (ADR-0012)
// ============================================================================

/** 封印平文の構造化 schema 識別子 (ADR-0012)。`problems[]` を持つ試験バンドル。 */
export type ExamBundleSchema = 'tcexam-exam/1';

/**
 * バンドル内の1問 (ADR-0012)。**1問 = 1タブ**で展開される。
 * `starter` は任意の単一スターターコードファイル (無ければ空タブ)。1問複数ファイルは現状非対応。
 */
export interface ExamBundleProblem {
  problemId: string;
  /** 問題文 (Markdown) */
  statement: string;
  /** スターターコード (任意)。`TemplateFileDefinition` を再利用 (テンプレート機能と共通)。 */
  starter?: TemplateFileDefinition;
}

/**
 * 封印される平文の構造化版 (ADR-0012)。1つの `.tcexam` に N 問をバンドルし、
 * 解錠時に各 `problems[i]` を1タブへ展開する。`packageHash`(署名) が全体を覆い、
 * 各タブの束縛は per-problem `problemContentHash` (root v2) が担う。
 */
export interface ExamBundle {
  schema: ExamBundleSchema;
  problems: ExamBundleProblem[];
}

/**
 * 復号後平文を解釈した結果 (ADR-0012)。後方互換のため、構造化されていない平文は
 * 旧来の単一 Markdown 問題 (`legacy`) として扱う。
 */
export type DecodedExamPlaintext =
  | { kind: 'bundle'; bundle: ExamBundle }
  | { kind: 'legacy'; statement: string };

/**
 * proof の `exam` ブロック (exam モード時のみ、ADR-0006 §4)。
 * grader がこのブロック + 公開 package だけで self-contained に検証できる。
 */
export interface ExamProofBlock {
  examProofVersion: number;
  examId: string;
  problemId: string;
  variant: string | null;
  /** SHA-256(deterministicStringify(signing core)) */
  packageHash: string;
  /** 復号後**平文**問題の SHA-256 (事前公開しない) */
  problemContentHash: string;
  /** 監督コード。T0 後は公開値。self-contained 検証用に保存 */
  startToken: string;
  /** root 束縛のバージョン (現状 'v1') */
  rootBinding: string;
}
