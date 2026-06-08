import { describe, expect, it } from 'vitest';
import type { CreatedExamPackage } from '../examPackageAuthoring.js';
import { buildProctorMemo } from '../AuthorPage.js';

function fakeResult(): CreatedExamPackage {
  return {
    proctorToken: 'VRKKXZEX',
    packageHash: '8da5e05b4b2d6ee2b3d86d9998395bc1e60e9df23bb3d4b312f787d999756a58',
    manifest: {
      formatVersion: 1,
      examId: '2026-spring-cs101-final',
      problemId: 'p1',
      variant: null,
      kdf: { algorithm: 'argon2id', salt: '00', params: { memKiB: 1, iterations: 1, parallelism: 1 } },
      cipher: { algorithm: 'AES-256-GCM', iv: '00', ciphertext: 'AA==' },
      releaseTime: '2026-06-10T01:00:00.000Z',
      deadline: '2026-06-10T04:00:00.000Z',
      allowed: { languages: ['c'] },
      keyId: 'exam-202606-26021f',
      algorithm: 'ECDSA-P256',
      signature: 'ab',
    },
  };
}

describe('buildProctorMemo', () => {
  const memo = buildProctorMemo(fakeResult(), 'p1.tcexam', new Date('2026-06-08T03:00:00.000Z'));

  it('shows the proctor code grouped for readability', () => {
    expect(memo).toContain('VRKK-XZEX');
  });

  it('records the bound packageHash so the teacher can cross-check later', () => {
    expect(memo).toContain('8da5e05b4b2d6ee2b3d86d9998395bc1e60e9df23bb3d4b312f787d999756a58');
  });

  it('records the problem file name, examId, problemId, keyId and schedule', () => {
    expect(memo).toContain('p1.tcexam');
    expect(memo).toContain('2026-spring-cs101-final');
    expect(memo).toContain('exam-202606-26021f');
    expect(memo).toContain('2026-06-10T01:00:00.000Z');
    expect(memo).toContain('2026-06-10T04:00:00.000Z');
  });

  it('stamps the injected generation time', () => {
    expect(memo).toContain('2026-06-08T03:00:00.000Z');
  });
});
