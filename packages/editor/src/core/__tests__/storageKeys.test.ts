import { describe, expect, it } from 'vitest';
import {
  examPackagesKey,
  modeLocalStorageKeys,
  modeSessionStorageKeys,
  sessionActiveKey,
  sessionDbName,
  setStorageNamespace,
  tabsKey,
} from '../storageKeys.js';

describe('storage namespace for casual', () => {
  it('keeps legacy un-suffixed names so existing sessions migrate for free', () => {
    setStorageNamespace('casual');
    expect(sessionDbName()).toBe('typedcode-session');
    expect(tabsKey()).toBe('typedcode-tabs');
    expect(sessionActiveKey()).toBe('typedcode-session-active');
    expect(examPackagesKey()).toBe('typedcode-exam-packages');
  });
});

describe('storage namespace for exam', () => {
  it('suffixes every key with -exam', () => {
    setStorageNamespace('exam');
    expect(sessionDbName()).toBe('typedcode-session-exam');
    expect(tabsKey()).toBe('typedcode-tabs-exam');
    expect(sessionActiveKey()).toBe('typedcode-session-active-exam');
    expect(examPackagesKey()).toBe('typedcode-exam-packages-exam');
  });
});

describe('storage namespace for class and assignment', () => {
  it('suffixes the session db name with -class', () => {
    setStorageNamespace('class');
    expect(sessionDbName()).toBe('typedcode-session-class');
  });

  it('suffixes the session db name with -assignment', () => {
    setStorageNamespace('assignment');
    expect(sessionDbName()).toBe('typedcode-session-assignment');
  });
});

describe('setStorageNamespace is the single switch that re-points every getter', () => {
  it('re-evaluates getters after the namespace changes (no module-load capture)', () => {
    setStorageNamespace('exam');
    expect(tabsKey()).toBe('typedcode-tabs-exam');
    setStorageNamespace('casual');
    expect(tabsKey()).toBe('typedcode-tabs');
  });
});

describe('keys that the reset removes (modeLocalStorageKeys / modeSessionStorageKeys)', () => {
  it('lists only the current mode keys for casual (un-suffixed)', () => {
    setStorageNamespace('casual');
    expect(modeLocalStorageKeys()).toEqual(['typedcode-exam-packages', 'typedcode-class-problems']);
    expect(modeSessionStorageKeys()).toEqual(['typedcode-tabs', 'typedcode-session-active']);
  });

  it('lists only the suffixed keys for the current mode and none of the other modes', () => {
    setStorageNamespace('assignment');
    expect(modeLocalStorageKeys()).toEqual([
      'typedcode-exam-packages-assignment',
      'typedcode-class-problems-assignment',
    ]);
    expect(modeSessionStorageKeys()).toEqual(['typedcode-tabs-assignment', 'typedcode-session-active-assignment']);
  });

  it('never includes the mode-independent keys (terms, locale, theme)', () => {
    for (const mode of ['casual', 'class', 'assignment', 'exam'] as const) {
      setStorageNamespace(mode);
      const all = [...modeLocalStorageKeys(), ...modeSessionStorageKeys()];
      expect(all).not.toContain('typedcode-terms-accepted');
      expect(all).not.toContain('typedcode-locale');
      expect(all).not.toContain('typedcode-theme');
    }
  });
});
