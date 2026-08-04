/**
 * ResultDataService (buildResultData) の入力検証のテスト。
 *
 * proof.json は攻撃者が自由に組み立てられる入力。UI へ渡す ResultData を組み立てる
 * この境界で、自己申告 mode を allowlist に落としておく (#210 の入力層の防御)。
 */

import { describe, expect, it } from 'vitest';
import { buildResultData } from '../ResultDataService.js';
import type { VerifyTabState } from '../../types.js';

/** mode 以外は最小構成の検証済みタブ状態。 */
function tabState(mode: unknown): VerifyTabState {
  return {
    id: 'tab-1',
    filename: 'main.py',
    language: 'python',
    status: 'verified',
    progress: 100,
    proofData: {
      mode,
      content: '',
      proof: { events: [] },
    },
    verificationResult: {
      chainValid: true,
      isPureTyping: true,
    },
  } as unknown as VerifyTabState;
}

describe('buildResultData — self-asserted mode', () => {
  it('passes through a known mode', () => {
    expect(buildResultData(tabState('exam'))?.mode).toBe('exam');
  });

  it('drops a mode carrying an HTML payload so the UI never renders it', () => {
    expect(buildResultData(tabState('<img src=x onerror=alert(1)>'))?.mode).toBeUndefined();
  });

  it('drops an unknown mode label', () => {
    expect(buildResultData(tabState('teacher'))?.mode).toBeUndefined();
  });

  it('leaves mode undefined for legacy proofs without the field', () => {
    expect(buildResultData(tabState(undefined))?.mode).toBeUndefined();
  });
});
