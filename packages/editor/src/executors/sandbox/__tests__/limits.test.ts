/**
 * 実行の上限の上書き (dev 限定フック `__tcExecLimits` の値の解釈) のテスト (#290)。
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_EXECUTION_LIMITS, resolveExecutionLimits } from '../limits.js';

describe('resolveExecutionLimits', () => {
  it('uses the defaults when there is no override', () => {
    expect(resolveExecutionLimits(undefined)).toEqual({
      timeoutMs: 30_000,
      outputBudgetChars: 1_000_000,
      readyTimeoutMs: 10_000,
    });
    expect(resolveExecutionLimits(null)).toEqual(DEFAULT_EXECUTION_LIMITS);
  });

  it('applies only positive finite overrides and keeps the defaults for the rest', () => {
    expect(resolveExecutionLimits({ timeoutMs: 1500, outputBudgetChars: 2000.7, readyTimeoutMs: -1 })).toEqual({
      timeoutMs: 1500,
      outputBudgetChars: 2000,
      readyTimeoutMs: 10_000,
    });
    expect(resolveExecutionLimits({ timeoutMs: Number.POSITIVE_INFINITY, outputBudgetChars: '10' })).toEqual(
      DEFAULT_EXECUTION_LIMITS
    );
  });
});
