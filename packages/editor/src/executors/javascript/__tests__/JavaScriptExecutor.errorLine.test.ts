/**
 * 実行時エラーが指す行がユーザーコードの行と一致することのテスト (エディタのマーカーの行)。
 *
 * AsyncFunction が足す前置きの行数はエンジンが決めるので、固定値で引くとずれる。
 */

import { describe, it, expect } from 'vitest';
import { JavaScriptExecutor } from '../JavaScriptExecutor.js';

describe('JavaScriptExecutor error location', () => {
  it('reports a runtime error at the user line where it was thrown', async () => {
    const executor = new JavaScriptExecutor();
    await executor.initialize();
    let stderr = '';
    const result = await executor.run('const a = 1;\nconst b = 2;\nnull.x;', {
      onStdout: () => {},
      onStderr: (text) => {
        stderr += text;
      },
    });
    expect(result.success).toBe(false);
    expect(executor.parseErrors(stderr)).toEqual([expect.objectContaining({ line: 3, column: 6 })]);
  });
});
