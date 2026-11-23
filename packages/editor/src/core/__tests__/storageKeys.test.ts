import { describe, expect, it } from 'vitest';
import {
  classPolicyKey,
  examPackagesKey,
  instanceGuardNamespace,
  modeLocalStorageKeys,
  modeSessionStorageKeys,
  modeStorageNamespace,
  pendingClassPackageKey,
  sessionActiveKey,
  sessionDbName,
  setStorageNamespace,
  setWorkspaceStorageNamespace,
  tabsKey,
  workspaceStorageNamespace,
} from '../storageKeys.js';
import type { ClassWorkspace } from '../mode.js';

const CLASSROOM = { screenshots: true, fullscreenTracking: true, preExportBestEffort: true };
const TAKE_HOME = { screenshots: false, fullscreenTracking: false, preExportBestEffort: false };
const LEGACY_MODES = ['casual', 'class', 'assignment', 'exam'] as const;

function classWs(classId: string, policy = CLASSROOM): ClassWorkspace {
  return { kind: 'class', classId, policy };
}

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
    expect(modeLocalStorageKeys()).toEqual([
      'typedcode-exam-packages',
      'typedcode-class-problems',
      'typedcode-class-policy',
    ]);
    expect(modeSessionStorageKeys()).toEqual([
      'typedcode-tabs',
      'typedcode-session-active',
      'typedcode-pending-class-package',
    ]);
  });

  it('lists only the suffixed keys for the current mode and none of the other modes', () => {
    setStorageNamespace('assignment');
    expect(modeLocalStorageKeys()).toEqual([
      'typedcode-exam-packages-assignment',
      'typedcode-class-problems-assignment',
      'typedcode-class-policy-assignment',
    ]);
    expect(modeSessionStorageKeys()).toEqual([
      'typedcode-tabs-assignment',
      'typedcode-session-active-assignment',
      'typedcode-pending-class-package-assignment',
    ]);
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

describe('storage namespace for a workspace (#646)', () => {
  it('names every key with -w:class:<encoded classId>:<policy code>', () => {
    setWorkspaceStorageNamespace(classWs('2026-algo-week3'));
    expect([sessionDbName(), tabsKey(), classPolicyKey(), pendingClassPackageKey()]).toEqual([
      'typedcode-session-w:class:2026-algo-week3:classroom',
      'typedcode-tabs-w:class:2026-algo-week3:classroom',
      'typedcode-class-policy-w:class:2026-algo-week3:classroom',
      'typedcode-pending-class-package-w:class:2026-algo-week3:classroom',
    ]);
    setStorageNamespace('casual');
  });

  it('gives the same classId with a different policy a different session db', () => {
    expect(sessionDbName(workspaceStorageNamespace(classWs('c', CLASSROOM)))).not.toBe(
      sessionDbName(workspaceStorageNamespace(classWs('c', TAKE_HOME)))
    );
  });

  it('never collides with the legacy per-mode namespaces', () => {
    const legacy = LEGACY_MODES.map(modeStorageNamespace);
    for (const ws of [classWs('class'), classWs('exam', TAKE_HOME), classWs('')]) {
      expect(legacy).not.toContain(workspaceStorageNamespace(ws));
    }
  });

  it('keeps a .tcclass workspace and a .tcexam workspace with the same id apart', () => {
    expect(workspaceStorageNamespace(classWs('lesson'))).not.toBe(
      workspaceStorageNamespace({ kind: 'exam', examId: 'lesson' })
    );
  });

  it('derives the keys of another namespace without switching the current one', () => {
    setStorageNamespace('casual');
    const target = workspaceStorageNamespace(classWs('c', TAKE_HOME));
    expect([pendingClassPackageKey(target), tabsKey()]).toEqual([
      'typedcode-pending-class-package-w:class:c:take-home',
      'typedcode-tabs',
    ]);
  });
});

describe('instanceGuardNamespace', () => {
  it('keeps the legacy guard name equal to the mode', () => {
    for (const mode of LEGACY_MODES) {
      setStorageNamespace(mode);
      expect(instanceGuardNamespace()).toBe(mode);
    }
  });

  it('names a workspace guard after the workspace so two workspaces run side by side', () => {
    setWorkspaceStorageNamespace(classWs('a'));
    const a = instanceGuardNamespace();
    setWorkspaceStorageNamespace(classWs('b'));
    expect([a, instanceGuardNamespace()]).toEqual(['w:class:a:classroom', 'w:class:b:classroom']);
    setStorageNamespace('casual');
  });
});
