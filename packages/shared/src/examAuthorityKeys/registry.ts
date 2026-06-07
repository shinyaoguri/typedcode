/**
 * 試験問題パッケージ署名用の出題者 (exam authority) 公開鍵レジストリ (ADR-0006)
 *
 * checkpointKeys/registry.ts と**同型**だが用途・主体・失効が別系統:
 * - checkpointKeys = サーバが署名 cp に使う鍵 (時刻アンカー)
 * - examAuthorityKeys = 出題者が `.tcexam` 問題パッケージに使う鍵 (問題の真正性)
 *
 * このファイルは git で永続管理される唯一の公開鍵真実情報源:
 * - 鍵は revoke しても削除しない (`status: 'revoked'` で残す)
 * - 過去 proof / 問題パッケージの検証可能性を維持するため、historical commit から鍵を辿れる
 * - editor (問題取り込み) / verify / verify-cli (grader) すべてここを参照する
 *
 * 鍵生成: `node packages/workers/scripts/generate-exam-authority-key.mjs`
 */

import type { SignedCheckpointAlgorithm } from '../types/proof.js';

export type ExamAuthorityKeyStatus = 'active' | 'revoked';

export interface ExamAuthorityKey {
  keyId: string;
  /** 現状 ECDSA-P256 のみ (checkpointKeys と共有のアルゴリズム型) */
  algorithm: SignedCheckpointAlgorithm;
  publicKeyJwk: JsonWebKey; // ECDSA P-256
  status: ExamAuthorityKeyStatus;
  /** 鍵が有効になった時刻 (ISO 8601) */
  validFrom: string;
  /** 鍵の有効終了時刻 (ISO 8601)。未設定なら未失効 */
  validUntil?: string;
  /**
   * revoke された時刻 (ISO 8601)。設定されると status は 'revoked' のはず。
   * この時刻より前に署名された問題パッケージは warning 付きで trust する
   */
  revokedAt?: string;
  /** 人間可読な説明 (オプショナル) */
  description?: string;
}

/**
 * 本番 exam authority 公開鍵レジストリ (append-only)
 *
 * **このファイルは本番運用される鍵のみを記述する。PR でレビューする想定。**
 *
 * 各出題者の dev 鍵は `localKeys.ts` に書く (skip-worktree 推奨)。
 * keyId 規約: `exam-YYYYMM-xxxxxx` (例: `exam-2026s-ab12cd` のように学期を含めても良い)。
 *
 * 運用ルール:
 * - 一度追加した鍵は revoke しても配列から削除しない (`status: 'revoked'` + `revokedAt` で残す)
 * - 過去の答案 proof / 問題パッケージの検証可能性を維持するため historical commit から鍵を辿れることが重要
 */
export const EXAM_AUTHORITY_KEYS: readonly ExamAuthorityKey[] = [
  // 本番鍵はここに append する。
  //
  // ── プレビュー/staging 検証用鍵 (ADR-0006 e2e) ───────────────────────────
  // CI クリーンビルド (Pages preview / staging) で ExamStartGate の解錠フローを
  // 実機確認するための鍵。秘密鍵は maintainer がローカル保管し、配布サンプル
  // `.tcexam` の署名にのみ使う。本番運用の試験問題には使わない。
  // 過去 proof を束縛していないため、検証が済めば (本番鍵と違い) このエントリは
  // 安全に削除できる。
  {
    keyId: 'exam-202606-preview',
    algorithm: 'ECDSA-P256',
    publicKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'ngCgvkUMSi4lz8X5qtvrVffFOu1KawHTV2AUUd3LRS8',
      y: 'CwzBS7YUXi6_Re9hFZPTLlmAp7vRqjwtaFBxQA0JpGA',
    },
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
    description:
      'プレビュー/staging 検証用 (ADR-0006 e2e)。秘密鍵は maintainer がローカル保管。本番試験には使わない',
  },
] as const;

/**
 * keyId から出題者公開鍵を解決する。registry に存在しなければ undefined。
 */
export function findExamAuthorityKey(
  keyId: string,
  registry: readonly ExamAuthorityKey[] = EXAM_AUTHORITY_KEYS
): ExamAuthorityKey | undefined {
  return registry.find((k) => k.keyId === keyId);
}
