// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classPolicyKey, setStorageNamespace } from '../../core/storageKeys.js';
import { ClassPolicyStore } from '../ClassPolicyStore.js';

const TAKE_HOME = { screenshots: false, fullscreenTracking: false, preExportBestEffort: false };

describe('ClassPolicyStore', () => {
  beforeEach(() => {
    setStorageNamespace('class');
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    setStorageNamespace('casual');
  });

  it('returns the saved policy so a reload starts with the same capabilities', () => {
    ClassPolicyStore.save(TAKE_HOME);
    expect(ClassPolicyStore.get()).toEqual(TAKE_HOME);
  });

  it('forgets the policy when a package without a policy is loaded', () => {
    ClassPolicyStore.save(TAKE_HOME);
    ClassPolicyStore.save(null);
    expect(ClassPolicyStore.get()).toBeNull();
  });

  it('keeps the policy of one mode out of the other modes', () => {
    ClassPolicyStore.save(TAKE_HOME);
    setStorageNamespace('assignment');
    expect(ClassPolicyStore.get()).toBeNull();
  });

  it('falls back to no policy for a stored value that is partial or not JSON', () => {
    localStorage.setItem(classPolicyKey(), JSON.stringify({ screenshots: false }));
    expect(ClassPolicyStore.get()).toBeNull();
    localStorage.setItem(classPolicyKey(), '{broken');
    expect(ClassPolicyStore.get()).toBeNull();
  });
});
