import { describe, expect, it } from 'vitest';
import { summarizeVerification } from '../verificationSummary.js';
import type { VerificationStatus } from '../../types.js';

type Tab = Parameters<typeof summarizeVerification>[0][number];

function proof(id: string, status: VerificationStatus): Tab {
  return { id, status };
}

describe('summarizeVerification', () => {
  it('counts a warning as passed and reports one failure for a success/warning/error set', () => {
    const summary = summarizeVerification([proof('a', 'success'), proof('b', 'warning'), proof('c', 'error')]);

    expect(summary).toEqual({ total: 3, passed: 2, failed: 1, done: true, firstFailedId: 'c' });
  });

  it('does not count plaintext or image tabs', () => {
    const summary = summarizeVerification([
      proof('a', 'success'),
      { id: 'p', status: 'success', isPlaintext: true },
      { id: 'q', status: 'warning', isPlaintext: true },
      { id: 'i', status: 'success', isImage: true },
    ]);

    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  it('reports 1/1 for a single proof', () => {
    expect(summarizeVerification([proof('a', 'success')])).toMatchObject({
      total: 1,
      passed: 1,
      failed: 0,
      done: true,
    });
  });

  it('counts an error tab that never entered the verification queue (unreadable proof) as failed', () => {
    const summary = summarizeVerification([proof('ok', 'success'), { id: 'broken', status: 'error' }]);

    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 1, firstFailedId: 'broken' });
  });

  it.each<VerificationStatus>(['pending', 'verifying'])('is not done while a proof is still %s', (status) => {
    const summary = summarizeVerification([proof('a', 'error'), proof('b', status)]);

    expect(summary.done).toBe(false);
  });

  it('picks the first failed proof in display order', () => {
    const summary = summarizeVerification([proof('a', 'success'), proof('b', 'error'), proof('c', 'error')]);

    expect(summary.firstFailedId).toBe('b');
  });

  it('is done with no proofs at all', () => {
    expect(summarizeVerification([])).toEqual({ total: 0, passed: 0, failed: 0, done: true, firstFailedId: null });
  });
});
