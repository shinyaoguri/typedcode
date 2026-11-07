import { describe, expect, it } from 'vitest';
import { deriveFailedCheck, unreadableResultEntry, type FailedCheckInput } from '../resultJson.js';

/**
 * `failedCheck` の優先順位 (#588)。`verifyProofFile` の `errorMessage` が採る順
 * (version → metadata/root → chain → finalHash → checkpoint → content → rootAnchor → sessionToken
 * → signed checkpoint → policy) と一致することを、分岐ごとに固定する。
 */
const OK: FailedCheckInput = {
  valid: false,
  versionStatus: 'current',
  metadataValid: true,
  rootValid: true,
  chainValid: true,
  finalHashValid: true,
  contentValid: true,
  checkpointValid: true,
  sessionTokenMismatch: false,
  policyViolationCodes: [],
};

describe('deriveFailedCheck', () => {
  it('is null when valid, whatever the fields say', () => {
    expect(deriveFailedCheck({ ...OK, valid: true })).toBeNull();
    expect(deriveFailedCheck({ ...OK, valid: true, chainValid: false })).toBeNull();
  });

  it('version: a rejected version status wins over every other failure', () => {
    expect(deriveFailedCheck({ ...OK, versionStatus: 'tooOld', metadataValid: false, chainValid: false })).toBe(
      'version'
    );
    expect(deriveFailedCheck({ ...OK, versionStatus: 'malformed' })).toBe('version');
  });

  it('a newer (not rejected) version does not count as version', () => {
    expect(deriveFailedCheck({ ...OK, versionStatus: 'newer', policyViolationCodes: ['root-anchor-missing'] })).toBe(
      'policy'
    );
  });

  it('root: metadata invalid because the root does not match', () => {
    expect(deriveFailedCheck({ ...OK, metadataValid: false, rootValid: false, chainValid: false })).toBe('root');
  });

  it('metadata: metadata invalid while the root is fine', () => {
    expect(deriveFailedCheck({ ...OK, metadataValid: false })).toBe('metadata');
  });

  it('chain: finalHash is forced false by a chain failure, errorAt tells them apart', () => {
    expect(
      deriveFailedCheck({ ...OK, chainValid: false, finalHashValid: false, contentValid: false, errorAt: 3 })
    ).toBe('chain');
  });

  it('finalHash: the chain verifies but the final hash differs (no errorAt)', () => {
    expect(deriveFailedCheck({ ...OK, chainValid: false, finalHashValid: false })).toBe('finalHash');
  });

  it('checkpoint: only the hash-chain checkpoints fail', () => {
    expect(deriveFailedCheck({ ...OK, chainValid: false, checkpointValid: false, errorAt: 5 })).toBe('checkpoint');
  });

  it('content: only the replayed content differs', () => {
    expect(deriveFailedCheck({ ...OK, chainValid: false, contentValid: false })).toBe('content');
  });

  it('chain beats content when both fail', () => {
    expect(
      deriveFailedCheck({ ...OK, chainValid: false, finalHashValid: false, contentValid: false, errorAt: 0 })
    ).toBe('chain');
  });

  it('rootAnchor: the session start token could not be verified', () => {
    expect(deriveFailedCheck({ ...OK, rootAnchorFailure: { code: 'token-invalid' } })).toBe('rootAnchor');
  });

  it('sessionToken: token and signed checkpoint disagree on the session', () => {
    expect(deriveFailedCheck({ ...OK, sessionTokenMismatch: true })).toBe('sessionToken');
  });

  it('rootAnchor beats sessionToken', () => {
    expect(deriveFailedCheck({ ...OK, rootAnchorFailure: {}, sessionTokenMismatch: true })).toBe('rootAnchor');
  });

  it('checkpoint: an anchored signed checkpoint that is invalid', () => {
    expect(deriveFailedCheck({ ...OK, signedCheckpoints: { anchored: true, valid: false } })).toBe('checkpoint');
  });

  it('an unanchored invalid signed checkpoint result does not block', () => {
    expect(deriveFailedCheck({ ...OK, signedCheckpoints: { anchored: false, valid: false } })).toBe('other');
  });

  it('policy: integrity is fine but a --require-* gate is violated', () => {
    expect(deriveFailedCheck({ ...OK, policyViolationCodes: ['signed-checkpoints-missing'] })).toBe('policy');
  });

  it('sessionToken beats policy', () => {
    expect(
      deriveFailedCheck({ ...OK, sessionTokenMismatch: true, policyViolationCodes: ['root-anchor-missing'] })
    ).toBe('sessionToken');
  });

  it('other: invalid with no layer to blame (exam binding / screenshots / submission)', () => {
    expect(deriveFailedCheck(OK)).toBe('other');
  });
});

describe('unreadableResultEntry', () => {
  it('is an invalid entry blamed on unreadable, with no assurance', () => {
    expect(unreadableResultEntry('b_proof.json', 'invalid JSON')).toEqual({
      filename: 'b_proof.json',
      valid: false,
      integrityValid: false,
      failedCheck: 'unreadable',
      errorMessage: 'invalid JSON',
      rootAnchored: false,
      temporal: null,
      policyViolations: [],
    });
  });
});
