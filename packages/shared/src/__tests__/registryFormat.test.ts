/**
 * 公開鍵レジストリの形式検証 (#233)
 *
 * `validFrom` / `validUntil` / `revokedAt` は system-spec §9.4 の revoke 手順で **手書き** する。
 * 検証側は parse 不能な日時を持つエントリを信頼しない (fail-closed, `checkRegistryKeyValidityAt`) が、
 * それは「typo った鍵で署名されたものが全部落ちる」という事後の壊れ方でしかない。
 * typo は**この形式テストが CI で止める**のが本命。
 *
 * 検査対象は merged なレジストリ (registry.ts + 手元の localKeys.ts。gitignore 済み。#338) の両系統。
 *
 * 注: `Date.parse` は寛容で、`'2026-02-30T00:00:00Z'` のような溢れた日付を
 * ロールオーバーして受け入れてしまう (実測)。ここでは厳密な ISO-8601 (UTC) 正規表現と
 * 「往復して同じ瞬間になるか」の両方で縛る。
 */

import { describe, expect, it } from 'vitest';
import { CHECKPOINT_PUBLIC_KEYS, asDevelopmentKeys, checkRegistryKeyValidityAt } from '../checkpointKeys/index.js';
import { CHECKPOINT_PUBLIC_KEYS as REGISTRY_CHECKPOINT_KEYS } from '../checkpointKeys/registry.js';
import { EXAM_AUTHORITY_KEYS } from '../examAuthorityKeys/index.js';
import type { RegistryKeyValidityFields } from '../checkpointKeys/index.js';

/** `2026-05-28T14:43:43.346Z` / `2020-01-01T00:00:00Z` 形式のみ許す (UTC 固定・秒必須) */
const STRICT_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function expectStrictIsoUtc(value: string, label: string): void {
  expect(value, label).toMatch(STRICT_ISO_UTC);
  const ts = Date.parse(value);
  expect(Number.isFinite(ts), `${label}: Date.parse が有限であること`).toBe(true);
  // ロールオーバー検出: 2026-02-30 は Date.parse を通っても往復で 2026-03-02 になる。
  expect(new Date(ts).toISOString().slice(0, 19), `${label}: 実在する日時であること`).toBe(value.slice(0, 19));
}

const REGISTRIES: ReadonlyArray<{ name: string; entries: readonly RegistryKeyValidityFields[] }> = [
  { name: 'checkpointKeys (merged)', entries: CHECKPOINT_PUBLIC_KEYS },
  { name: 'examAuthorityKeys (merged)', entries: EXAM_AUTHORITY_KEYS },
];

describe.each(REGISTRIES)('registry format: $name', ({ entries }) => {
  it('すべてのエントリの日時が厳密な ISO-8601 (UTC) で実在すること', () => {
    for (const entry of entries) {
      expectStrictIsoUtc(entry.validFrom, `${entry.keyId}.validFrom`);
      if (entry.validUntil !== undefined) expectStrictIsoUtc(entry.validUntil, `${entry.keyId}.validUntil`);
      if (entry.revokedAt !== undefined) expectStrictIsoUtc(entry.revokedAt, `${entry.keyId}.revokedAt`);
    }
  });

  it("status: 'revoked' のエントリには revokedAt があること", () => {
    for (const entry of entries) {
      if (entry.status === 'revoked') {
        expect(entry.revokedAt, `${entry.keyId}: revoked なら revokedAt が要る`).toBeDefined();
      }
    }
  });

  it('validFrom <= validUntil / revokedAt であること', () => {
    for (const entry of entries) {
      const from = Date.parse(entry.validFrom);
      if (entry.validUntil !== undefined) {
        expect(Date.parse(entry.validUntil), `${entry.keyId}: validUntil は validFrom 以降`).toBeGreaterThanOrEqual(
          from
        );
      }
      if (entry.revokedAt !== undefined) {
        expect(Date.parse(entry.revokedAt), `${entry.keyId}: revokedAt は validFrom 以降`).toBeGreaterThanOrEqual(from);
      }
    }
  });

  it('日時の不備を理由に検証側から信頼を落とされるエントリが無いこと', () => {
    // anchor は validFrom 直後。ここで malformed-date が出るなら registry 側の typo。
    for (const entry of entries) {
      const verdict = checkRegistryKeyValidityAt(entry, Date.parse(entry.validFrom) + 1);
      if (!verdict.ok) {
        expect(verdict.code, `${entry.keyId}: registry の日時が parse 不能`).not.toBe('malformed-date');
      }
    }
  });

  it('keyId が重複しないこと (findCheckpointPublicKey は先勝ちで解決する)', () => {
    const ids = entries.map((e) => e.keyId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * 鍵の環境 (#321)。検証器は環境で時刻証拠に数えるかを決めるので、registry.ts のエントリに環境が無いと
 * (JSON の registry と同じく) 信頼されなくなる。追加した鍵の書き忘れ・綴りの誤りをここで止める。
 */
describe('registry format: checkpoint key environments (#321)', () => {
  it('gives every registry.ts entry an environment of production or staging', () => {
    for (const entry of REGISTRY_CHECKPOINT_KEYS) {
      expect(['production', 'staging'], `${entry.keyId}.environment`).toContain(entry.environment);
    }
  });

  it('keeps the production and staging keys apart (the staging key is not labeled production)', () => {
    const environmentOf = (keyId: string) => REGISTRY_CHECKPOINT_KEYS.find((k) => k.keyId === keyId)?.environment;

    expect(environmentOf('tcp-202605-fd6d42')).toBe('production');
    expect(environmentOf('tcp-202606-0e46c9')).toBe('staging');
  });

  it('labels a local key as development even when it claims another environment', () => {
    const [local] = asDevelopmentKeys([
      {
        keyId: 'tcp-local-claims-production',
        algorithm: 'ECDSA-P256',
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        status: 'active',
        validFrom: '2026-01-01T00:00:00Z',
        environment: 'production',
      } as Parameters<typeof asDevelopmentKeys>[0][number],
    ]);

    expect(local?.environment).toBe('development');
  });
});
