/**
 * C / C++ のコンパイラ診断がエディタのマーカーに届く経路 (#708)。
 *
 * CodeExecutionController に本物の CExecutor / CppExecutor をつなぎ、@wasmer/sdk だけを偽物にする。
 * マーカーは onShowErrors (main.ts が `setModelMarkers(model, 'c-compiler', …)` に写す) と
 * onClearErrors (次の run の開始で同じ owner を空にする) の呼ばれ方で見る。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeExecutionEventData } from '@typedcode/shared';
import type { ParsedError } from '../../executors/interfaces/ILanguageExecutor.js';
import type { CTerminal } from '../../terminal/CTerminal.js';

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));
vi.mock('../../executors/javascript/JavaScriptExecutor.js', () => ({ getJavaScriptExecutor: () => null }));
vi.mock('../../executors/typescript/TypeScriptExecutor.js', () => ({ getTypeScriptExecutor: () => null }));
vi.mock('../../executors/python/PythonExecutor.js', () => ({ getPythonExecutor: () => null }));

/** 偽 SDK: コンパイルの結果だけをテストが決める。プログラムは何も出さずに exit 0 で終わる */
const compile = vi.hoisted(() => ({ exitCode: 0, stderr: '' }));

vi.mock('@wasmer/sdk', () => {
  const captured = (text: string) => ({ bytes: new TextEncoder().encode(text), truncated: false, text: () => text });
  const empty = { async *[Symbol.asyncIterator]() {} };
  class FakeSandbox {
    fs = { readFile: async () => new Uint8Array([0, 0x61, 0x73, 0x6d]) };
    async installPackage() {
      return { id: 'program' };
    }
    command() {
      return {
        run: async () => ({
          exitCode: compile.exitCode,
          reason: 'exited',
          stdout: captured(''),
          stderr: captured(compile.stderr),
        }),
        spawn: async () => ({
          stdin: null,
          stdout: empty,
          stderr: empty,
          wait: async () => ({ exitCode: 0, reason: 'exited' }),
          kill: async () => {},
        }),
      };
    }
    async close() {}
  }
  class Wasmer {
    packages = { load: async () => ({ id: 'clang' }) };
    sandboxes = { create: async () => new FakeSandbox() };
    async ready() {
      return this;
    }
    async close() {}
  }
  return { Wasmer };
});

const { CodeExecutionController } = await import('../CodeExecutionController.js');

const FORMAT_WARNING =
  "/workspace/main.c:3:24: warning: format specifies type 'int' but the argument has type 'char *' [-Wformat]\n" +
  '1 warning generated.\n';
const FATAL_ERROR = "/workspace/main.c:2:10: fatal error: 'student.h' file not found\n1 error generated.\n";

function setup() {
  const controller = new CodeExecutionController();
  const written: string[] = [];
  const terminal = {
    clear: () => {},
    write: (t: string) => written.push(t),
    writeError: (t: string) => written.push(t),
    writeInfo: () => {},
    writeSuccess: () => {},
    disconnectStdin: () => {},
    connectStdin: () => {},
    markRunStarted: () => {},
    markRunFinished: () => {},
  } as unknown as CTerminal;
  /** onShowErrors / onClearErrors を呼ばれた順に並べたもの (マーカーの最終状態はこの末尾で決まる) */
  const markerCalls: (ParsedError[] | 'clear')[] = [];
  const results: CodeExecutionEventData[] = [];
  controller.setTerminal(terminal);
  controller.setCallbacks({
    onShowErrors: (errors) => markerCalls.push(errors),
    onClearErrors: () => markerCalls.push('clear'),
    onRecordEvent: (e) => {
      if (e.data?.phase === 'result') results.push(e.data);
    },
  });
  return { controller, written, markerCalls, results };
}

beforeEach(() => {
  compile.exitCode = 0;
  compile.stderr = '';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // clang の webc の取得 (初回の initialize) だけを偽物にする
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('compiler diagnostics reach the editor markers (#708)', () => {
  it('shows the warning of a successful C compile at its source line and keeps the run a success', async () => {
    const { controller, written, markerCalls, results } = setup();
    compile.stderr = FORMAT_WARNING;

    await controller.run({ language: 'c', filename: 'main.c', code: 'int main(void){}' });

    expect(written.filter((t) => t === FORMAT_WARNING)).toHaveLength(1);
    expect(markerCalls).toEqual(['clear', [expect.objectContaining({ line: 3, column: 24, severity: 'warning' })]]);
    expect(results).toEqual([expect.objectContaining({ outcome: 'success', exitCode: 0 })]);
  });

  it('clears the markers of the previous run before the next run reports anything', async () => {
    const { controller, markerCalls } = setup();
    compile.stderr = FORMAT_WARNING;
    await controller.run({ language: 'c', filename: 'main.c', code: 'int main(void){}' });

    compile.stderr = '';
    await controller.run({ language: 'c', filename: 'main.c', code: 'int main(void){return 0;}' });

    expect(markerCalls).toEqual(['clear', [expect.objectContaining({ severity: 'warning' })], 'clear']);
  });

  it('shows a fatal error of a failed compile as an error marker once', async () => {
    const { controller, written, markerCalls, results } = setup();
    compile.exitCode = 1;
    compile.stderr = FATAL_ERROR;

    await controller.run({ language: 'c', filename: 'main.c', code: '#include "student.h"' });

    expect(written.filter((t) => t === FATAL_ERROR)).toHaveLength(1);
    expect(markerCalls).toEqual([
      'clear',
      [
        {
          line: 2,
          column: 10,
          severity: 'error',
          message: "'student.h' file not found",
        },
      ],
    ]);
    expect(results).toEqual([expect.objectContaining({ outcome: 'failure', exitCode: 1 })]);
  });

  it('shows the warning of a successful C++ compile through the same path', async () => {
    const { controller, markerCalls, results } = setup();
    compile.stderr = "/workspace/main.cpp:2:9: warning: unused variable 'n' [-Wunused-variable]\n";

    await controller.run({ language: 'cpp', filename: 'main.cpp', code: 'int main(){ int n; }' });

    expect(markerCalls).toEqual(['clear', [expect.objectContaining({ line: 2, column: 9, severity: 'warning' })]]);
    expect(results).toEqual([expect.objectContaining({ outcome: 'success', exitCode: 0 })]);
  });
});
