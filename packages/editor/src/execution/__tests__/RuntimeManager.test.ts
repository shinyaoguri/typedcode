// @vitest-environment happy-dom
/**
 * RuntimeManager の表示と C の runtime の作り直し (#617)。
 *
 * - ランタイムの表示 (`#runtime-state-indicator`) は状態を `data-runtime-state` (状態契約) に出す
 * - C をまだ実行していない (実行系を読み込む前) なら、runtime の作り直しは何も読み込まない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));

const { RuntimeManager } = await import('../RuntimeManager.js');
const { getLazyCExecutor } = await import('../../executors/c/LazyClangExecutor.js');

const indicator = (): HTMLElement => document.getElementById('runtime-state-indicator')!;

beforeEach(() => {
  document.body.innerHTML = '<span class="runtime-state-indicator" id="runtime-state-indicator"></span>';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('RuntimeManager (#617)', () => {
  it('exposes the runtime state of an executable language as data-runtime-state and follows its changes', () => {
    const runtime = new RuntimeManager();

    runtime.updateIndicator('c');
    expect(indicator().getAttribute('data-runtime-state')).toBe('not-ready');
    runtime.setStatus('c', 'loading');
    runtime.updateIndicator('cpp');
    expect(indicator().getAttribute('data-runtime-state')).toBe('loading');
    runtime.updateIndicator('javascript');
    expect(indicator().getAttribute('data-runtime-state')).toBe('ready');
  });

  it('removes data-runtime-state for a language that cannot be executed', () => {
    const runtime = new RuntimeManager();
    runtime.updateIndicator('c');

    runtime.updateIndicator('html');

    expect(indicator().hasAttribute('data-runtime-state')).toBe(false);
  });

  it('does not load the C runtime when resetting it before any C run', async () => {
    const runtime = new RuntimeManager();

    await runtime.resetCRuntime();

    expect(getLazyCExecutor().isLoaded).toBe(false);
    expect(runtime.getStatus('c')).toBe('not-ready');
  });
});
