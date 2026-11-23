// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClassPackage } from '@typedcode/shared';
import { pendingClassPackageKey, setStorageNamespace, setWorkspaceStorageNamespace } from '../../core/storageKeys.js';
import { PendingClassPackageStore } from '../PendingClassPackageStore.js';

const POLICY = { screenshots: false, fullscreenTracking: false, preExportBestEffort: false };
const WORKSPACE = { kind: 'class', classId: 'c', policy: POLICY } as const;
const TARGET_NS = '-w:class:c:take-home';

const PKG: ClassPackage = {
  schema: 'tcclass/1',
  classId: 'c',
  allowed: { languages: ['c'] },
  policy: POLICY,
  bundle: { schema: 'tcexam-exam/1', problems: [{ problemId: 'p1', statement: '# p1' }] },
};

describe('PendingClassPackageStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    setStorageNamespace('casual');
  });
  afterEach(() => {
    sessionStorage.clear();
    setStorageNamespace('casual');
  });

  it('hands a package from the current page to the target workspace', () => {
    expect(PendingClassPackageStore.put(TARGET_NS, PKG)).toBe(true);
    setWorkspaceStorageNamespace(WORKSPACE);
    expect(PendingClassPackageStore.take()).toEqual(PKG);
  });

  it('hands the package over only once so a reload does not open the problems again', () => {
    PendingClassPackageStore.put(TARGET_NS, PKG);
    setWorkspaceStorageNamespace(WORKSPACE);
    PendingClassPackageStore.take();
    expect(PendingClassPackageStore.take()).toBeNull();
  });

  it('does not hand the package to the page that wrote it', () => {
    PendingClassPackageStore.put(TARGET_NS, PKG);
    expect(PendingClassPackageStore.take()).toBeNull();
  });

  it('drops a stored value that is not a class package', () => {
    setWorkspaceStorageNamespace(WORKSPACE);
    sessionStorage.setItem(pendingClassPackageKey(), JSON.stringify({ schema: 'tcclass/1' }));
    expect([PendingClassPackageStore.take(), sessionStorage.getItem(pendingClassPackageKey())]).toEqual([null, null]);
  });
});
