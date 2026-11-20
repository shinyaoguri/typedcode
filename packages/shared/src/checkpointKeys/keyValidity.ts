/**
 * 公開鍵レジストリのエントリが、ある時刻 (anchor) で有効かを判定する共通ロジック (#233)
 *
 * checkpoint 署名鍵 (`checkpointKeys`) と出題者鍵 (`examAuthorityKeys`) は**別系統**だが、
 * 有効期間・失効の表現は同型 (`status` / `validFrom` / `validUntil` / `revokedAt`)。
 * 消費者は 3 つある:
 *
 * | 消費者 | anchor |
 * |---|---|
 * | `signedCheckpoints.ts` | envelope の `serverTimestamp` |
 * | `sessionStartToken.ts` | token の `issuedAt` |
 * | `exam/examPackage.ts`  | manifest の `releaseTime` |
 *
 * かつては 3 箇所が同じ判定を各自で書いており、`Number.isFinite(Date.parse(...))` ガードの
 * せいで **日時が parse 不能だと有効性検査そのものがスキップされる** fail-open を 3 つとも
 * 抱えていた (`status: 'revoked'` の鍵が警告すら出さずに信頼される)。registry の日時は
 * system-spec §9.4 の revoke 手順で手書きするので typo は現実に起こりうる。
 *
 * ここに判定を 1 本化し、**parse 不能な日時を持つエントリは信頼しない** (fail-closed)。
 * 粒度はエントリ単位 — registry 全体を無効化すると typo 1 つで全提出物が検証失敗する。
 *
 * verdict は意味コードだけを返し、利用者向けの文言は呼び出し側が組み立てる
 * (anchor の呼び名が消費者ごとに違うため)。
 */

/** registry エントリのうち、有効性判定に使うフィールドだけを抜き出した構造型 */
export interface RegistryKeyValidityFields {
  keyId: string;
  status: 'active' | 'revoked';
  validFrom: string;
  validUntil?: string;
  revokedAt?: string;
}

/** parse 不能だったフィールド名 */
export type RegistryKeyDateField = 'validFrom' | 'validUntil' | 'revokedAt';

export type RegistryKeyVerdict =
  /** 有効。`revokedAfterAnchor` は「anchor より後に revoke された鍵」= 信頼するが警告 */
  | { ok: true; revokedAfterAnchor?: true }
  | { ok: false; code: 'malformed-date'; field: RegistryKeyDateField }
  | { ok: false; code: 'not-yet-valid' | 'expired' | 'revoked-before-anchor' | 'revoked-without-revoked-at' };

/**
 * 鍵の信頼状態を機械可読にした列挙 (#809)。`checkRegistryKeyValidityAt` の verdict と「registry に無い」を
 * 1 つの値で表す。消費者 (署名 cp / sessionStartToken / 出題者鍵) の結果に、自由文の `reason` とは別に載せる。
 *
 * - `trusted`: registry にあり、anchor の時点で有効
 * - `trusted-revoked-after-anchor`: anchor より後に失効した鍵。信頼するが警告を添える
 * - `unknown`: keyId が registry に無い (この検証器の registry が古い可能性もある)
 * - `revoked`: anchor 以前に失効した鍵、または `revokedAt` の無い `status: 'revoked'`
 * - `expired` / `not-yet-valid`: anchor が有効期間の外
 * - `malformed-entry`: registry のエントリの日時が parse できない (fail-closed で信頼しない)
 */
export type RegistryKeyTrustStatus =
  | 'trusted'
  | 'trusted-revoked-after-anchor'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'not-yet-valid'
  | 'malformed-entry';

/**
 * verdict を `RegistryKeyTrustStatus` に写す (判定はしない。判定は `checkRegistryKeyValidityAt` だけが持つ)。
 * 「registry に無い」は verdict を作る前に分かるので、`unknown` は呼び出し側が自分で付ける。
 */
export function registryKeyTrustStatus(verdict: RegistryKeyVerdict): Exclude<RegistryKeyTrustStatus, 'unknown'> {
  if (verdict.ok) {
    return verdict.revokedAfterAnchor ? 'trusted-revoked-after-anchor' : 'trusted';
  }
  switch (verdict.code) {
    case 'malformed-date':
      return 'malformed-entry';
    case 'not-yet-valid':
      return 'not-yet-valid';
    case 'expired':
      return 'expired';
    case 'revoked-before-anchor':
    case 'revoked-without-revoked-at':
      return 'revoked';
  }
}

/**
 * registry エントリが `anchorTs` (epoch ms) の時点で有効かを判定する。
 *
 * - `validFrom` / `validUntil` / `revokedAt` のいずれかが parse 不能なら `malformed-date`
 *   (存在しない optional フィールドは検査しない)
 * - `revokedAt` より前の anchor は信頼するが `revokedAfterAnchor` を立てる
 * - `revokedAt` 無しの `status: 'revoked'` は安全側で拒否
 */
export function checkRegistryKeyValidityAt(entry: RegistryKeyValidityFields, anchorTs: number): RegistryKeyVerdict {
  const validFromTs = Date.parse(entry.validFrom);
  if (!Number.isFinite(validFromTs)) {
    return { ok: false, code: 'malformed-date', field: 'validFrom' };
  }
  if (anchorTs < validFromTs) {
    return { ok: false, code: 'not-yet-valid' };
  }

  if (entry.validUntil !== undefined) {
    const validUntilTs = Date.parse(entry.validUntil);
    if (!Number.isFinite(validUntilTs)) {
      return { ok: false, code: 'malformed-date', field: 'validUntil' };
    }
    if (anchorTs > validUntilTs) {
      return { ok: false, code: 'expired' };
    }
  }

  if (entry.revokedAt !== undefined) {
    const revokedTs = Date.parse(entry.revokedAt);
    if (!Number.isFinite(revokedTs)) {
      return { ok: false, code: 'malformed-date', field: 'revokedAt' };
    }
    if (anchorTs >= revokedTs) {
      return { ok: false, code: 'revoked-before-anchor' };
    }
    // 失効前に署名されたものは信頼するが警告を添える (registry の運用方針)。
    return { ok: true, revokedAfterAnchor: true };
  }

  if (entry.status === 'revoked') {
    return { ok: false, code: 'revoked-without-revoked-at' };
  }
  return { ok: true };
}
