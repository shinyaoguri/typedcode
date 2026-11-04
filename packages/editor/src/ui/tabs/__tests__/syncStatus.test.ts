/**
 * 保存の結果から同期状態を決める純関数 (#543)。
 * 同期状態は「永続化できたか」を表し、保存の失敗は PoSW 待ち (pending) より優先する。
 */

import { describe, it, expect } from 'vitest';
import { isPersistFailure, resolveSyncStatus, type SyncStatus } from '../syncStatus.js';

describe('resolveSyncStatus (#543)', () => {
  it('is synced when both IndexedDB and sessionStorage were written and nothing awaits PoSW', () => {
    expect(resolveSyncStatus({ idbOk: true, sessionStorageOk: true, hasPendingEvents: false })).toBe('synced');
  });

  it('is pending when both stores were written but some events still await PoSW', () => {
    expect(resolveSyncStatus({ idbOk: true, sessionStorageOk: true, hasPendingEvents: true })).toBe('pending');
  });

  it('is degraded when only IndexedDB failed', () => {
    expect(resolveSyncStatus({ idbOk: false, sessionStorageOk: true, hasPendingEvents: false })).toBe('degraded');
  });

  it('is degraded when only sessionStorage failed', () => {
    expect(resolveSyncStatus({ idbOk: true, sessionStorageOk: false, hasPendingEvents: false })).toBe('degraded');
  });

  it('is failed when neither IndexedDB nor sessionStorage could be written', () => {
    expect(resolveSyncStatus({ idbOk: false, sessionStorageOk: false, hasPendingEvents: false })).toBe('failed');
  });

  it('reports a save failure over PoSW-pending events instead of hiding it as pending', () => {
    expect(resolveSyncStatus({ idbOk: false, sessionStorageOk: true, hasPendingEvents: true })).toBe('degraded');
    expect(resolveSyncStatus({ idbOk: false, sessionStorageOk: false, hasPendingEvents: true })).toBe('failed');
  });
});

describe('isPersistFailure (#543)', () => {
  it('treats only degraded and failed as save failures', () => {
    const all: SyncStatus[] = ['synced', 'syncing', 'pending', 'degraded', 'failed'];
    expect(all.filter(isPersistFailure)).toEqual(['degraded', 'failed']);
  });
});
