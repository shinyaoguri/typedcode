/**
 * 検証モードの初期値を URL クエリ `?mode=` で上書きする (E2E 用)。既定 (`full`) は変えない。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VERIFY_MODE, resolveInitialVerifyMode } from '../verifyModeQuery.js';
import type { VerificationMode } from '../../types.js';

describe('resolveInitialVerifyMode', () => {
  it('keeps the full re-computation default when no mode is requested', () => {
    expect(DEFAULT_VERIFY_MODE).toBe('full');
    expect(resolveInitialVerifyMode('')).toBe('full');
  });

  it.each<VerificationMode>(['fast', 'audit', 'full'])('honours ?mode=%s', (mode) => {
    expect(resolveInitialVerifyMode(`?mode=${mode}`)).toBe(mode);
  });

  it('reads the mode among other query parameters and without a leading question mark', () => {
    expect(resolveInitialVerifyMode('?lang=en&mode=fast')).toBe('fast');
    expect(resolveInitialVerifyMode('mode=audit')).toBe('audit');
  });

  it.each(['FAST', 'turbo', '', 'fast ', 'skip'])('falls back to the default for the unknown mode %j', (raw) => {
    expect(resolveInitialVerifyMode(`?mode=${encodeURIComponent(raw)}`)).toBe('full');
  });
});
