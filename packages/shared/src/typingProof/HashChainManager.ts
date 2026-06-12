/**
 * HashChainManager - ハッシュチェーン管理
 * SHA-256計算、決定的文字列化、チェーン状態管理を担当
 */

import {
  deterministicStringify as deterministicStringifyUtil,
  arrayBufferToHex as arrayBufferToHexUtil,
  computeHash as computeHashUtil,
} from '../utils/hashUtils.js';
import { sharedDebugLog } from '../utils/debug.js';

/** タイムスタンプ調整の結果 */
interface TimestampAdjustment {
  timestamp: number;
  wasAdjusted: boolean;
}

/** シーケンス検証の結果 */
interface SequenceValidation {
  sequence: number;
  wasCorrected: boolean;
}

/** 初期ハッシュ生成結果 */
interface InitialHashResult {
  hash: string;
  nonce: string;
}

export class HashChainManager {
  private currentHash: string | null = null;

  /** タイムスタンプ調整のマージン (ms) */
  private static readonly TIMESTAMP_MARGIN = 10;

  /**
   * 現在のハッシュを取得
   */
  getCurrentHash(): string | null {
    return this.currentHash;
  }

  /**
   * 現在のハッシュを設定
   */
  setCurrentHash(hash: string | null): void {
    this.currentHash = hash;
  }

  /**
   * 初期ハッシュを生成（フィンガープリント + ランダム値）
   */
  async generateInitialHash(fingerprintHash: string): Promise<InitialHashResult> {
    const randomData = new Uint8Array(32);
    crypto.getRandomValues(randomData);
    const randomHex = this.arrayBufferToHex(randomData);

    return {
      hash: await this.computeInitialHash(fingerprintHash, randomHex),
      nonce: randomHex,
    };
  }

  /**
   * 保存済みnonceから初期ハッシュを再計算
   */
  async computeInitialHash(fingerprintHash: string, nonce: string): Promise<string> {
    return await this.computeHash(fingerprintHash + nonce);
  }

  /**
   * 試験モード (ADR-0006/0012) の初期ハッシュ (= チェーン根) を生成。
   * - v1: root = SHA-256(fingerprintHash ‖ nonce ‖ packageHash ‖ startToken)。
   * - v2 (N問バンドル, ADR-0012 B-2): 末尾に per-problem `problemContentHash` を連結。
   * genesis は監督コード入力 (= T0)。casual の generateInitialHash と対をなす。
   *
   * 注: この連結式は exam/examPackage.ts の `computeExamChainRoot` と**必ず一致**させること
   * (verifier はそちらで root を再計算する)。両者の一致はテストで担保している。
   * `problemContentHash` 省略時は v1 とバイト一致する。
   */
  async generateExamInitialHash(
    fingerprintHash: string,
    packageHash: string,
    startToken: string,
    problemContentHash?: string
  ): Promise<InitialHashResult> {
    const randomData = new Uint8Array(32);
    crypto.getRandomValues(randomData);
    const nonce = this.arrayBufferToHex(randomData);
    const suffix = problemContentHash ?? '';
    const hash = await this.computeHash(fingerprintHash + nonce + packageHash + startToken + suffix);
    return { hash, nonce };
  }

  /**
   * セッション開始トークン (ADR-0017) による anchored 初期ハッシュ (= チェーン根) を生成。
   *   root = SHA-256(fingerprintHash ‖ localNonce ‖ serverNonce)
   * serverNonce は session/start でサーバが署名トークンに焼いた 32 バイト hex。これを root に
   * 連結することで「完全オフライン捏造」を封じる (localNonce のみの generateInitialHash と対をなす)。
   *
   * 注: この連結式は sessionStartToken.ts の `computeAnchoredChainRoot` と**必ず一致**させること
   * (verifier はそちらで root を再計算する)。両者の一致はテストで担保する。
   */
  async generateAnchoredInitialHash(
    fingerprintHash: string,
    serverNonce: string
  ): Promise<InitialHashResult> {
    const randomData = new Uint8Array(32);
    crypto.getRandomValues(randomData);
    const localNonce = this.arrayBufferToHex(randomData);
    const hash = await this.computeHash(fingerprintHash + localNonce + serverNonce);
    return { hash, nonce: localNonce };
  }

  /**
   * 初期ハッシュを生成（後方互換API）
   */
  async initialHash(fingerprintHash: string): Promise<string> {
    return (await this.generateInitialHash(fingerprintHash)).hash;
  }

  /**
   * オブジェクトをキーがソートされた決定的なJSON文字列に変換
   * ハッシュ計算時の一貫性を保証するため、キー順序を常にソート
   */
  deterministicStringify(obj: unknown): string {
    return deterministicStringifyUtil(obj);
  }

  /**
   * ArrayBufferを16進数文字列に変換
   */
  arrayBufferToHex(buffer: ArrayBuffer | Uint8Array): string {
    return arrayBufferToHexUtil(buffer);
  }

  /**
   * 文字列からSHA-256ハッシュを計算
   */
  async computeHash(data: string): Promise<string> {
    return computeHashUtil(data);
  }

  /**
   * シーケンス番号を検証し、必要に応じて修正
   * @param pendingSequence - 保存されていたシーケンス番号
   * @param expectedSequence - 期待されるシーケンス番号（events配列の長さ）
   * @returns 検証結果（使用するシーケンス番号と修正があったかどうか）
   */
  validateSequence(pendingSequence: number, expectedSequence: number): SequenceValidation {
    if (pendingSequence !== expectedSequence) {
      console.warn(`[HashChainManager] Sequence mismatch: pending=${pendingSequence}, expected=${expectedSequence}. Using expected value.`);
      return { sequence: expectedSequence, wasCorrected: true };
    }
    return { sequence: expectedSequence, wasCorrected: false };
  }

  /**
   * タイムスタンプの単調増加を保証
   * @param timestamp - 現在のタイムスタンプ
   * @param lastTimestamp - 最後のイベントのタイムスタンプ
   * @returns 調整結果（使用するタイムスタンプと調整があったかどうか）
   */
  ensureMonotonicTimestamp(timestamp: number, lastTimestamp: number): TimestampAdjustment {
    if (timestamp <= lastTimestamp) {
      const adjustedTimestamp = lastTimestamp + HashChainManager.TIMESTAMP_MARGIN;
      sharedDebugLog(`[HashChainManager] Adjusting timestamp: ${timestamp.toFixed(2)} -> ${adjustedTimestamp.toFixed(2)} (last: ${lastTimestamp.toFixed(2)})`);
      return { timestamp: adjustedTimestamp, wasAdjusted: true };
    }
    return { timestamp, wasAdjusted: false };
  }

  /**
   * previousHashの整合性を検証
   * @param storedPreviousHash - 保存されていたpreviousHash
   * @param currentHash - 現在のcurrentHash
   * @returns 使用するpreviousHash
   */
  validatePreviousHash(storedPreviousHash: string | null, currentHash: string | null): string | null {
    if (storedPreviousHash !== null && storedPreviousHash !== currentHash) {
      sharedDebugLog(`[HashChainManager] previousHash mismatch, using current. stored: ${storedPreviousHash?.substring(0, 16)}..., current: ${currentHash?.substring(0, 16)}...`);
    }
    return currentHash;
  }
}
