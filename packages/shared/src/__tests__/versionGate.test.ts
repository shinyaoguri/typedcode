/**
 * proof.version のバージョンゲート (#223) のテスト。
 *
 * - `parseVersionStrict` / `isVersionSupported` は不正形式を NaN で素通しせず拒否する
 * - `classifyProofVersion` が current / supported / newer / tooOld / malformed に分類する
 * - `verifyProofFile` が入口で分類し、下限未満・不正形式は reject、未知の新 major は warning (`versionStatus`) のみ
 *
 * `proof.version` は `typingProofHash` の入力ではないので、実 proof の version だけを書き換えても
 * 他の検査の結論は変わらない (ゲートが唯一の効き目になる)。
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_SUPPORTED_VERSION,
  PROOF_FORMAT_VERSION,
  TypingProof,
  classifyProofVersion,
  computeHash,
  isProofVersionRejected,
  isVersionSupported,
  parseVersionStrict,
  proofVersionRejectionMessage,
  verifyProofFile,
  type FingerprintComponents,
} from '../index.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (VersionGate Test)',
  language: 'en',
  languages: ['en'],
  platform: 'TestOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: {
    width: 1440,
    height: 900,
    availWidth: 1440,
    availHeight: 860,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
  },
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'mock-canvas',
  webgl: { vendor: 'Mock', renderer: 'Mock' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

async function buildProof() {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);
  let content = '';
  for (const ch of ['a', 'b', 'c']) {
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }
  const exported = await proof.exportProof(content);
  return { ...exported, content, language: 'text' };
}

type BuiltProof = Awaited<ReturnType<typeof buildProof>>;

/** version だけを書き換えた proof (欠落・型違いも表せるよう unknown で受ける) */
function withVersion(proofFile: BuiltProof, version: unknown): BuiltProof {
  const copy: Record<string, unknown> = { ...proofFile };
  if (version === undefined) delete copy.version;
  else copy.version = version;
  return copy as unknown as BuiltProof;
}

describe('parseVersionStrict', () => {
  it('parses a MAJOR.MINOR.PATCH string into numbers', () => {
    expect(parseVersionStrict('1.2.0')).toEqual({ major: 1, minor: 2, patch: 0 });
  });

  it('rejects strings that are not MAJOR.MINOR.PATCH instead of letting NaN through', () => {
    const bads = [
      'abc',
      '1',
      '1.2',
      '1.2.0-beta',
      '1.2.0.4',
      '',
      ' 1.2.0',
      '1.2.0 ',
      'v1.2.0',
      '1.a.0',
      '01.2.0',
      '-1.0.0',
    ];
    for (const bad of bads) {
      expect(parseVersionStrict(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects non-string values', () => {
    for (const bad of [undefined, null, 1, 1.2, {}, ['1', '2', '0']]) {
      expect(parseVersionStrict(bad)).toBeNull();
    }
  });

  it('rejects components too large to compare safely', () => {
    expect(parseVersionStrict('99999999999999999999.0.0')).toBeNull();
  });
});

describe('isVersionSupported', () => {
  it('is false for strings that are not MAJOR.MINOR.PATCH (#223: abc used to pass)', () => {
    expect(isVersionSupported('abc')).toBe(false);
    expect(isVersionSupported('1')).toBe(false);
    expect(isVersionSupported('1.2.0-beta')).toBe(false);
  });

  it('is true at the lower bound and above, false just below it', () => {
    expect(isVersionSupported(MIN_SUPPORTED_VERSION)).toBe(true);
    expect(isVersionSupported('1.0.1')).toBe(true);
    expect(isVersionSupported('2.0.0')).toBe(true);
    expect(isVersionSupported('0.99.99')).toBe(false);
  });
});

describe('classifyProofVersion', () => {
  it('classifies the current format version as current', () => {
    expect(classifyProofVersion(PROOF_FORMAT_VERSION)).toBe('current');
  });

  it('classifies older versions at or above the lower bound as supported', () => {
    expect(classifyProofVersion('1.0.0')).toBe('supported');
    expect(classifyProofVersion('1.1.0')).toBe('supported');
  });

  it('classifies a newer minor of the known major as supported (additive changes)', () => {
    expect(classifyProofVersion('1.99.0')).toBe('supported');
  });

  it('classifies a major above the known one as newer', () => {
    expect(classifyProofVersion('2.0.0')).toBe('newer');
    expect(classifyProofVersion('10.3.1')).toBe('newer');
  });

  it('classifies versions below the lower bound as tooOld', () => {
    expect(classifyProofVersion('0.9.0')).toBe('tooOld');
    expect(classifyProofVersion('0.0.0')).toBe('tooOld');
  });

  it('classifies missing and ill-formed versions as malformed', () => {
    for (const bad of [undefined, null, 1, 'abc', '1', '1.2.0-beta', '']) {
      expect(classifyProofVersion(bad), JSON.stringify(bad)).toBe('malformed');
    }
  });

  it('rejects only tooOld and malformed', () => {
    expect(isProofVersionRejected('tooOld')).toBe(true);
    expect(isProofVersionRejected('malformed')).toBe(true);
    for (const ok of ['current', 'supported', 'newer'] as const) {
      expect(isProofVersionRejected(ok)).toBe(false);
    }
  });

  it('never echoes an ill-formed self-declared version into the rejection message', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const message = proofVersionRejectionMessage(classifyProofVersion(hostile), hostile);
    expect(message).toBeDefined();
    expect(message).not.toContain('<img');
  });
});

describe('verifyProofFile version gate (#223)', () => {
  it('keeps accepting a proof at the current version and reports it as current', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(proofFile, undefined, { mode: 'fast' });
    expect(result.valid).toBe(true);
    expect(result.versionStatus).toBe('current');
  });

  it('keeps accepting proofs at every released format version (1.0.0 to 1.2.0)', async () => {
    const proofFile = await buildProof();
    for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
      const result = await verifyProofFile(withVersion(proofFile, version), undefined, { mode: 'fast' });
      expect(result.valid, version).toBe(true);
    }
  });

  it('rejects a proof whose version is below the lower bound and names the version in the error', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(withVersion(proofFile, '0.9.0'), undefined, { mode: 'fast' });
    expect(result.valid).toBe(false);
    expect(result.versionStatus).toBe('tooOld');
    expect(result.errorMessage).toMatch(/version/i);
  });

  it('rejects a proof whose version is not MAJOR.MINOR.PATCH', async () => {
    const proofFile = await buildProof();
    for (const bad of ['abc', '1', '1.2.0-beta']) {
      const result = await verifyProofFile(withVersion(proofFile, bad), undefined, { mode: 'fast' });
      expect(result.valid, bad).toBe(false);
      expect(result.versionStatus, bad).toBe('malformed');
      expect(result.errorMessage, bad).toMatch(/version/i);
    }
  });

  it('rejects a proof with no version', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(withVersion(proofFile, undefined), undefined, { mode: 'fast' });
    expect(result.valid).toBe(false);
    expect(result.versionStatus).toBe('malformed');
  });

  it('rejects a proof whose version is not a string', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(withVersion(proofFile, 1.2), undefined, { mode: 'fast' });
    expect(result.valid).toBe(false);
    expect(result.versionStatus).toBe('malformed');
  });

  it('does not let a version rejection hide the other layers (chain still verifies on its own)', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(withVersion(proofFile, '0.9.0'), undefined, { mode: 'fast' });
    expect(result.chainValid).toBe(true);
    expect(result.metadataValid).toBe(true);
  });

  it('flags a newer major as newer without rejecting a proof that is otherwise valid', async () => {
    const proofFile = await buildProof();
    const result = await verifyProofFile(withVersion(proofFile, '2.0.0'), undefined, { mode: 'fast' });
    expect(result.versionStatus).toBe('newer');
    expect(result.valid).toBe(true);
    expect(result.errorMessage).not.toMatch(/version/i);
  });

  it('leaves a newer-major proof invalid when another check fails (version is only a warning)', async () => {
    const proofFile = await buildProof();
    const tampered = { ...withVersion(proofFile, '2.0.0'), content: 'tampered' };
    const result = await verifyProofFile(tampered, undefined, { mode: 'fast' });
    expect(result.versionStatus).toBe('newer');
    expect(result.valid).toBe(false);
  });
});
