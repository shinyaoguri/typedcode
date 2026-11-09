/**
 * 試験の #0 humanAttestation の組み立て (#236)。ゲート中に先行取得した token があれば verified の印、
 * 解錠の瞬間に未決着 (null) なら従来の合成 best-effort の印になる。
 */

import { describe, it, expect } from 'vitest';
import type { SessionStartToken } from '@typedcode/shared';
import {
  EXAM_ATTESTATION_ACTION,
  attestationFromSessionToken,
  buildExamHumanAttestation,
} from '../humanAttestation.js';

const token = {
  keyId: 'k1',
  payload: {
    sessionId: 'session-1',
    issuedAt: '2026-11-10T09:00:00.000Z',
    serverNonce: 'n'.repeat(64),
    action: 'exam_start',
    hostname: 'exam.example',
  },
  signature: 'sig',
} as unknown as SessionStartToken;

const env = { hostname: 'localhost', now: new Date('2026-11-10T09:05:00.000Z') };

describe('buildExamHumanAttestation (#236)', () => {
  it('records a verified attestation stamped by the session token when the gate obtained one', () => {
    const attestation = buildExamHumanAttestation({ success: true, score: 1, sessionToken: token }, env);

    expect(attestation).toEqual({
      verified: true,
      score: 1,
      action: 'exam_start',
      timestamp: '2026-11-10T09:00:00.000Z',
      hostname: 'exam.example',
      signature: 'session-start-token:k1',
      success: true,
      failureReason: undefined,
    });
  });

  it('falls back to the unsigned synthetic attestation when the gate had not settled at unlock', () => {
    expect(buildExamHumanAttestation(null, env)).toEqual({
      verified: false,
      score: 0,
      action: EXAM_ATTESTATION_ACTION,
      timestamp: '2026-11-10T09:05:00.000Z',
      hostname: 'localhost',
      signature: 'unsigned',
      success: false,
    });
  });

  it('keeps the failure reason on the synthetic attestation when the gate attempt failed', () => {
    const attestation = buildExamHumanAttestation({ success: false, failureReason: 'network_error' }, env);

    expect(attestation.verified).toBe(false);
    expect(attestation.signature).toBe('unsigned');
    expect(attestation.failureReason).toBe('network_error');
  });

  it('does not claim verification for a success that carries no session token', () => {
    const attestation = buildExamHumanAttestation({ success: true, score: 1 }, env);

    expect(attestation.verified).toBe(false);
    expect(attestation.signature).toBe('unsigned');
  });
});

describe('attestationFromSessionToken', () => {
  it('falls back to the given action and hostname when the token omits them', () => {
    const bare = {
      ...token,
      payload: { ...token.payload, action: undefined, hostname: undefined },
    } as unknown as SessionStartToken;

    const attestation = attestationFromSessionToken({ success: true }, bare, 'create_tab', 'localhost');

    expect(attestation.action).toBe('create_tab');
    expect(attestation.hostname).toBe('localhost');
    expect(attestation.score).toBe(1);
  });
});
