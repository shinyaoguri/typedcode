import { describe, expect, it } from 'vitest';
import {
  allSessionDbNames,
  examPackagesKey,
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

describe('allSessionDbNames', () => {
  it('covers every mode session db plus the legacy screenshots db for ?reset', () => {
    expect(allSessionDbNames()).toEqual([
      'typedcode-session',
      'typedcode-session-class',
      'typedcode-session-assignment',
      'typedcode-session-exam',
      'typedcode-screenshots',
    ]);
  });

  it('is independent of the current namespace', () => {
    setStorageNamespace('exam');
    const underExam = allSessionDbNames();
    setStorageNamespace('casual');
    expect(allSessionDbNames()).toEqual(underExam);
  });
});
