import { describe, expect, it } from 'vitest';
import { shouldRecordTabSwitch } from '../tabSwitchPolicy.js';

describe('shouldRecordTabSwitch', () => {
  it('does not record a synthetic switch while restoring, even from a null previous tab', () => {
    expect(shouldRecordTabSwitch(null, 'a', true)).toBe(false);
  });

  it('does not record a switch between two tabs while restoring', () => {
    expect(shouldRecordTabSwitch('a', 'b', true)).toBe(false);
  });

  it('records the first activation (null previous tab) outside of restoring', () => {
    expect(shouldRecordTabSwitch(null, 'a', false)).toBe(true);
  });

  it('does not record a switch to the already active tab', () => {
    expect(shouldRecordTabSwitch('a', 'a', false)).toBe(false);
  });

  it('records a normal switch between different tabs', () => {
    expect(shouldRecordTabSwitch('a', 'b', false)).toBe(true);
  });
});
