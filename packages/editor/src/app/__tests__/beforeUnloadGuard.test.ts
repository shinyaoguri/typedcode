import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBeforeUnload, type BeforeUnloadContext } from '../beforeUnloadGuard.js';
import { sessionActiveKey } from '../../core/storageKeys.js';

function makeCtx(over: { skipBeforeUnload?: boolean; skipUnloadConfirm?: boolean; events?: number } = {}) {
  const saveToStorageSync = vi.fn();
  const ctx = {
    skipBeforeUnload: over.skipBeforeUnload ?? false,
    skipUnloadConfirm: over.skipUnloadConfirm ?? false,
    tabManager: {
      saveToStorageSync,
      getActiveProof: () => ({ events: new Array(over.events ?? 3) }),
    },
  } as unknown as BeforeUnloadContext;
  return { ctx, saveToStorageSync };
}

describe('handleBeforeUnload', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('sessionStorage', {
      setItem: (k: string, v: string) => void store.set(k, v),
      getItem: (k: string) => store.get(k) ?? null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for confirmation when the active tab has recorded events', () => {
    const { ctx } = makeCtx();
    const e = { preventDefault: vi.fn() };
    handleBeforeUnload(ctx, e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('does not ask for confirmation when the active tab has no events', () => {
    const { ctx } = makeCtx({ events: 0 });
    const e = { preventDefault: vi.fn() };
    handleBeforeUnload(ctx, e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('suppresses only the confirmation, still saving tab state and marking the session active, when skipUnloadConfirm is set', () => {
    const { ctx, saveToStorageSync } = makeCtx({ skipUnloadConfirm: true });
    const e = { preventDefault: vi.fn() };
    handleBeforeUnload(ctx, e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(saveToStorageSync).toHaveBeenCalledTimes(1);
    expect(store.get(sessionActiveKey())).toBe('true');
  });

  it('skips both the confirmation and the state save when skipBeforeUnload is set (reset confirm)', () => {
    const { ctx, saveToStorageSync } = makeCtx({ skipBeforeUnload: true });
    const e = { preventDefault: vi.fn() };
    handleBeforeUnload(ctx, e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(saveToStorageSync).not.toHaveBeenCalled();
    expect(store.has(sessionActiveKey())).toBe(false);
  });
});
