/**
 * CExecutor の @wasmer/sdk 0.19 API への載せ替え (#364) を、SDK を偽物に差し替えて確かめる。
 * 実際の clang / wasm の実行はブラウザでしか動かないので、ここでは CExecutor が SDK を
 * どう呼び、結果をどう ExecutionResult / callbacks に写すかだけを見る。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionCallbacks } from '../../interfaces/ILanguageExecutor.js';

/** 偽 SDK の状態。各テストが振る舞いを差し替える */
const sdk = vi.hoisted(() => {
  const state = {
    compile: { exitCode: 0, stdout: '', stderr: '' },
    stdoutChunks: [] as Uint8Array[],
    stderrChunks: [] as Uint8Array[],
    /** 実行プロセスの wait() を外から解決するためのフック (null なら即時 exitCode 0) */
    holdProcess: false,
    runExitCode: 0,
    releaseProcess: null as null | ((code: number) => void),
    sandboxFiles: [] as Record<string, string | Uint8Array>[],
    commands: [] as { selector: unknown; args: readonly string[] | undefined }[],
    sandboxClosed: 0,
    clientsClosed: 0,
    killed: 0,
    stdinStreams: [] as WritableStream<Uint8Array>[],
    reset() {
      state.compile = { exitCode: 0, stdout: '', stderr: '' };
      state.stdoutChunks = [];
      state.stderrChunks = [];
      state.holdProcess = false;
      state.runExitCode = 0;
      state.releaseProcess = null;
      state.sandboxFiles = [];
      state.commands = [];
      state.sandboxClosed = 0;
      state.clientsClosed = 0;
      state.killed = 0;
      state.stdinStreams = [];
    },
  };
  return state;
});

vi.mock('@wasmer/sdk', () => {
  const captured = (text: string) => ({ bytes: new TextEncoder().encode(text), truncated: false, text: () => text });
  const readable = (chunks: Uint8Array[]) => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  });

  class FakeSandbox {
    fs = { readFile: async () => new Uint8Array([0, 0x61, 0x73, 0x6d]) };
    async installPackage() {
      return { id: 'program' };
    }
    command(selector: unknown, args?: readonly string[]) {
      sdk.commands.push({ selector, args });
      const isCompile = sdk.commands.length === 1;
      return {
        run: async () => ({
          exitCode: sdk.compile.exitCode,
          reason: 'exited',
          stdout: captured(sdk.compile.stdout),
          stderr: captured(sdk.compile.stderr),
        }),
        spawn: async () => {
          if (isCompile) throw new Error('compile command must be run, not spawned');
          const stdin = new WritableStream<Uint8Array>();
          const exited = new Promise<number>((resolve) => {
            if (sdk.holdProcess) sdk.releaseProcess = resolve;
            else resolve(sdk.runExitCode);
          });
          return {
            stdin: {
              toWritableStream: () => {
                sdk.stdinStreams.push(stdin);
                return stdin;
              },
            },
            stdout: readable(sdk.stdoutChunks),
            stderr: readable(sdk.stderrChunks),
            wait: async () => ({ exitCode: await exited, reason: 'exited' }),
            kill: async () => {
              sdk.killed++;
              sdk.releaseProcess?.(137);
            },
          };
        },
      };
    }
    async close() {
      sdk.sandboxClosed++;
    }
  }

  class Wasmer {
    packages = { load: async () => ({ id: 'clang' }) };
    sandboxes = {
      create: async (options: { files: Record<string, string | Uint8Array> }) => {
        sdk.sandboxFiles.push(options.files);
        return new FakeSandbox();
      },
    };
    async ready() {
      return this;
    }
    async close() {
      sdk.clientsClosed++;
    }
  }

  return { Wasmer };
});

const { CExecutor, buildSourceWithPreamble } = await import('../CExecutor.js');
const { CppExecutor } = await import('../../cpp/CppExecutor.js');

function collectCallbacks() {
  const out = { stdout: '', stderr: '', stdin: null as WritableStream<Uint8Array> | null };
  const callbacks: ExecutionCallbacks = {
    onStdout: (text) => {
      out.stdout += text;
    },
    onStderr: (text) => {
      out.stderr += text;
    },
    onStdinReady: (stream) => {
      out.stdin = stream;
    },
  };
  return { out, callbacks };
}

const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));

beforeEach(() => {
  sdk.reset();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function readyExecutor() {
  const executor = new CExecutor();
  await executor.initialize();
  return executor;
}

describe('CExecutor on @wasmer/sdk 0.19', () => {
  it('compiles /workspace/<source> with the same clang arguments as before', async () => {
    const executor = await readyExecutor();
    const { callbacks } = collectCallbacks();

    await executor.run('int main(){return 0;}', callbacks);

    expect(Object.keys(sdk.sandboxFiles[0] ?? {})).toEqual(['/workspace/main.c']);
    expect(String(sdk.sandboxFiles[0]?.['/workspace/main.c'])).toContain('setvbuf(stdout, (char *)0, _IONBF, 0);');
    expect(sdk.commands[0]?.args).toEqual([
      '/workspace/main.c',
      '-o',
      '/workspace/main.wasm',
      '-target',
      'wasm32-wasi',
      '-O2',
    ]);
  });

  it('reports a compile failure with clang stderr and does not run the program', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    sdk.compile = { exitCode: 1, stdout: '', stderr: 'main.c:3:5: error: boom' };

    const result = await executor.run('bad', callbacks);

    expect(result).toEqual({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'main.c:3:5: error: boom',
      error: 'Compilation failed',
    });
    expect(out.stderr).toBe('main.c:3:5: error: boom');
    expect(sdk.commands).toHaveLength(1);
  });

  it('streams program output decoding UTF-8 sequences split across chunks', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    const bytes = new TextEncoder().encode('こんにちは\n');
    sdk.stdoutChunks = [bytes.slice(0, 4), bytes.slice(4)];
    sdk.stderrChunks = [new TextEncoder().encode('warn\n')];

    await executor.run('x', callbacks);

    expect(out.stdout).toBe('こんにちは\n');
    expect(out.stderr).toBe('warn\n');
  });

  it('returns the exit code of the program and hands its stdin stream to the caller', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    sdk.runExitCode = 3;

    const result = await executor.run('x', callbacks);

    expect(result).toEqual({ success: false, exitCode: 3, stdout: '', stderr: '' });
    expect(out.stdin).not.toBeNull();
    expect(out.stdin).toBe(sdk.stdinStreams[0]);
  });

  it('closes the per-run sandbox whether compilation succeeds or fails', async () => {
    const executor = await readyExecutor();
    await executor.run('ok', collectCallbacks().callbacks);
    sdk.compile = { exitCode: 1, stdout: '', stderr: 'err' };
    await executor.run('bad', collectCallbacks().callbacks);

    expect(sdk.sandboxClosed).toBe(2);
  });

  it('kills the running process on abort and marks the runtime for reset', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    sdk.holdProcess = true;

    const running = executor.run('while(1);', callbacks);
    await vi.waitFor(() => expect(sdk.releaseProcess).not.toBeNull());
    executor.abort();
    const result = await running;

    expect(sdk.killed).toBe(1);
    expect(out.stderr).toContain('[System] Program stopped.');
    expect(executor.isRuntimeCorrupted()).toBe(true);
    expect(result.exitCode).toBe(137);
  });

  it('closes the Wasmer client on reset and reinitializes without downloading clang again', async () => {
    const executor = await readyExecutor();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await executor.resetRuntime();
    expect(sdk.clientsClosed).toBe(1);

    await executor.initialize();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('compile error line numbers (#489)', () => {
  it('places `#line 1` immediately before the user code so clang numbers its lines from 1', () => {
    const source = buildSourceWithPreamble('int main(){return undefined_var;}');

    expect(source.endsWith('#line 1\nint main(){return undefined_var;}')).toBe(true);
    expect(source).toContain('setvbuf(stdout, (char *)0, _IONBF, 0);');
  });

  it('sends the #line-prefixed source to clang for both C and C++', async () => {
    for (const Executor of [CExecutor, CppExecutor]) {
      sdk.reset();
      const executor = new Executor();
      await executor.initialize();
      await executor.run('int main(){return 0;}', collectCallbacks().callbacks);

      const files = Object.values(sdk.sandboxFiles[0] ?? {});
      expect(files).toHaveLength(1);
      expect(String(files[0]).endsWith('#line 1\nint main(){return 0;}')).toBe(true);
    }
  });

  it('reads line 1 from a clang message that points at the first user line', () => {
    const executor = new CExecutor();

    expect(executor.parseErrors("main.c:1:19: error: use of undeclared identifier 'undefined_var'")).toEqual([
      { line: 1, column: 19, severity: 'error', message: "use of undeclared identifier 'undefined_var'" },
    ]);
    expect(executor.parseErrors('main.cpp:1:5: warning: unused variable')[0]?.line).toBe(1);
  });
});
