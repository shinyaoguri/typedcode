/**
 * JavaScriptExecutor が sandbox の結果を ExecutionResult に写し、停止を今の run に届けることのテスト (#290)。
 */

import { describe, it, expect, vi } from 'vitest';
import { JavaScriptExecutor, toExecutionResult } from '../JavaScriptExecutor.js';
import type { SandboxResult, SandboxRunner } from '../../sandbox/SandboxRunner.js';

describe('toExecutionResult', () => {
  it('carries the sandbox outcome and derives success only from a successful completion', () => {
    const base = { stdout: 'o', stderr: 'e' };
    expect(toExecutionResult({ ...base, outcome: 'success', exitCode: 0 })).toMatchObject({
      success: true,
      exitCode: 0,
      outcome: 'success',
    });
    expect(toExecutionResult({ ...base, outcome: 'timeout', exitCode: null })).toMatchObject({
      success: false,
      exitCode: 1,
      outcome: 'timeout',
    });
    expect(
      toExecutionResult({ ...base, outcome: 'error', exitCode: null, error: 'Output limit exceeded' })
    ).toMatchObject({ success: false, outcome: 'error', error: 'Output limit exceeded' });
  });
});

describe('JavaScriptExecutor', () => {
  it('aborts the run in progress through the sandbox', async () => {
    let resolve!: (r: SandboxResult) => void;
    const abort = vi.fn(() => resolve({ outcome: 'aborted', exitCode: null, stdout: '', stderr: '' }));
    const runner = {
      start: () => ({ result: new Promise<SandboxResult>((r) => (resolve = r)), abort }),
    } as unknown as SandboxRunner;
    const executor = new JavaScriptExecutor(runner);
    await executor.initialize();
    const running = executor.run('for(;;){}', { onStdout: () => {}, onStderr: () => {} });
    executor.abort();
    await expect(running).resolves.toMatchObject({ outcome: 'aborted', success: false });
    expect(abort).toHaveBeenCalledTimes(1);
    // 終わった run には二度と届けない
    executor.abort();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
