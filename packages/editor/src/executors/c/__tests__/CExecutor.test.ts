/**
 * CExecutor の @wasmer/sdk 0.19 API への載せ替え (#364) を、SDK を偽物に差し替えて確かめる。
 * 実際の clang / wasm の実行はブラウザでしか動かないので、ここでは CExecutor が SDK を
 * どう呼び、結果をどう ExecutionResult / callbacks に写すかだけを見る。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritableBytes } from '@wasmer/sdk';
import type { ExecutionCallbacks, InteractiveStdin } from '../../interfaces/ILanguageExecutor.js';

/** 偽 SDK の状態。各テストが振る舞いを差し替える */
const sdk = vi.hoisted(() => {
  /**
   * 止めて待ち合わせられる段階 (#711)。`holds` に入れた段階は、そこに着いた時点で止まり、
   * テストが `reached(stage)` で受け取った release を呼ぶまで進まない (固定の sleep に頼らない)。
   * release に数を渡すとその段階の終了コード (compile / program)、Error を渡すとその段階を reject する
   */
  type Stage = 'ready' | 'sandbox' | 'compile' | 'install' | 'program';
  type Release = (value?: number | Error) => void;
  const arrivals = new Map<Stage, Release[]>();
  const waiters = new Map<Stage, ((release: Release) => void)[]>();

  const state = {
    compile: { exitCode: 0, stdout: '', stderr: '' },
    stdoutChunks: [] as Uint8Array[],
    stderrChunks: [] as Uint8Array[],
    runExitCode: 0,
    holds: new Set<Stage>(),
    /** kill() が効かない SDK を真似る (プロセスは release されるまで終わらない) */
    killIgnored: false,
    sandboxFiles: [] as Record<string, string | Uint8Array>[],
    commands: [] as { selector: unknown; args: readonly string[] | undefined }[],
    /** 利用者プログラム (コンパイル結果) を spawn した回数 */
    programSpawns: 0,
    /** run が入った段階の順 (後続の段階へ進んでいないかを見る) */
    entered: [] as string[],
    sandboxClosed: 0,
    clientsClosed: 0,
    killed: 0,
    stdinStreams: [] as WritableStream<Uint8Array>[],
    /** 利用者プログラムの stdin への書き込みと close の順 (非対話の実行 #802) */
    stdinLog: [] as string[],
    /** 段階に着いたら止まる (holds に無ければそのまま進む) */
    arrive(stage: Stage): Promise<number | undefined> {
      if (!state.holds.has(stage)) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        const release: Release = (value) => (value instanceof Error ? reject(value) : resolve(value));
        const waiter = waiters.get(stage)?.shift();
        if (waiter) waiter(release);
        else arrivals.set(stage, [...(arrivals.get(stage) ?? []), release]);
      });
    },
    /** 次にその段階へ着いた run の release を返す (着くまで待つ) */
    reached(stage: Stage): Promise<Release> {
      const release = arrivals.get(stage)?.shift();
      if (release) return Promise.resolve(release);
      return new Promise((resolve) => waiters.set(stage, [...(waiters.get(stage) ?? []), resolve]));
    },
    reset() {
      state.compile = { exitCode: 0, stdout: '', stderr: '' };
      state.stdoutChunks = [];
      state.stderrChunks = [];
      state.runExitCode = 0;
      state.holds = new Set();
      state.killIgnored = false;
      state.sandboxFiles = [];
      state.commands = [];
      state.programSpawns = 0;
      state.entered = [];
      state.sandboxClosed = 0;
      state.clientsClosed = 0;
      state.killed = 0;
      state.stdinStreams = [];
      state.stdinLog = [];
      arrivals.clear();
      waiters.clear();
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

  /**
   * wait() が段階の release か kill() で終わるプロセス。段階に「着く」のは呼び出し側が
   * spawn の結果を受け取って wait() を呼んだ時点 (= プロセスを手にして待っている間)
   */
  function fakeProcess(stage: 'compile' | 'program', defaultExitCode: () => number) {
    let onKill: (code: number) => void = () => {};
    const killed = new Promise<number>((resolve) => {
      onKill = resolve;
    });
    let exited: Promise<number> | null = null;
    return {
      get exited() {
        exited ??= Promise.race([sdk.arrive(stage).then((code) => code ?? defaultExitCode()), killed]);
        return exited;
      },
      kill: async () => {
        sdk.killed++;
        if (!sdk.killIgnored) onKill(137);
      },
    };
  }

  class FakeSandbox {
    fs = {
      readFile: async () => {
        sdk.entered.push('readFile');
        return new Uint8Array([0, 0x61, 0x73, 0x6d]);
      },
    };
    async installPackage() {
      sdk.entered.push('install');
      await sdk.arrive('install');
      return { id: 'program' };
    }
    command(selector: { id: string }, args?: readonly string[]) {
      sdk.commands.push({ selector, args });
      const isCompile = selector.id === 'clang';
      return {
        run: async () => {
          throw new Error('compile must be spawned so that it can be killed (#711)');
        },
        spawn: async () => {
          if (isCompile) {
            sdk.entered.push('compile');
            const compiler = fakeProcess('compile', () => sdk.compile.exitCode);
            return {
              stdin: null,
              stdout: null,
              stderr: null,
              wait: async () => ({
                exitCode: await compiler.exited,
                reason: 'exited',
                stdout: captured(sdk.compile.stdout),
                stderr: captured(sdk.compile.stderr),
              }),
              kill: compiler.kill,
            };
          }
          sdk.programSpawns++;
          sdk.entered.push('program');
          const program = fakeProcess('program', () => sdk.runExitCode);
          const stdin = new WritableStream<Uint8Array>();
          return {
            stdin: {
              toWritableStream: () => {
                sdk.stdinStreams.push(stdin);
                return stdin;
              },
              write: async (data: string) => {
                sdk.stdinLog.push(`write:${data}`);
              },
              close: async () => {
                sdk.stdinLog.push('close');
              },
            },
            stdout: readable(sdk.stdoutChunks),
            stderr: readable(sdk.stderrChunks),
            wait: async () => ({ exitCode: await program.exited, reason: 'exited' }),
            kill: program.kill,
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
        sdk.entered.push('sandbox');
        await sdk.arrive('sandbox');
        return new FakeSandbox();
      },
    };
    async ready() {
      await sdk.arrive('ready');
      return this;
    }
    async close() {
      sdk.clientsClosed++;
    }
  }

  return { Wasmer };
});

const { CExecutor, buildSourceWithPreamble, pipeInteractiveStdin } = await import('../CExecutor.js');
const { CppExecutor } = await import('../../cpp/CppExecutor.js');

function collectCallbacks() {
  const out = { stdout: '', stderr: '', stdin: null as InteractiveStdin | null };
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

  it('returns the exit code of the program and hands its stdin to the caller', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    sdk.runExitCode = 3;

    const result = await executor.run('x', callbacks);

    expect(result).toEqual({ success: false, exitCode: 3, stdout: '', stderr: '' });
    expect(out.stdin).not.toBeNull();
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
    sdk.holds.add('program');

    const running = executor.run('while(1);', callbacks);
    await sdk.reached('program');
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

const encode = (text: string) => new TextEncoder().encode(text);

describe.each([
  ['C', () => new CExecutor()],
  ['C++', () => new CppExecutor()],
])('stopping a %s run before the program starts (#711)', (_language, create) => {
  async function ready() {
    const executor = create();
    await executor.initialize();
    return executor;
  }

  it.each(['sandbox', 'compile', 'install'] as const)(
    'does not enter any later stage, nor start the user program, when stopped while %s is pending',
    async (stage) => {
      const executor = await ready();
      const { out, callbacks } = collectCallbacks();
      sdk.holds.add(stage);
      // SDK がコンパイラを殺せない場合でも、停止した run が後続の段階へ進まないことを見る
      sdk.killIgnored = true;

      const running = executor.run('int main(void){ return 0; }', callbacks);
      const release = await sdk.reached(stage);
      executor.abort();
      release(0);
      const result = await running;

      expect(sdk.entered.at(-1)).toBe(stage);
      expect(sdk.programSpawns).toBe(0);
      expect(result).toMatchObject({ success: false, outcome: 'aborted' });
      expect(out.stdout).toBe('');
      expect(sdk.sandboxClosed).toBe(1);
    }
  );

  it('kills the compiler process when stopped during compilation', async () => {
    const executor = await ready();
    sdk.holds.add('compile');

    const running = executor.run('int main(void){ return 0; }', collectCallbacks().callbacks);
    await sdk.reached('compile');
    executor.abort();
    const result = await running;

    expect(sdk.killed).toBe(1);
    expect(sdk.programSpawns).toBe(0);
    expect(result).toMatchObject({ success: false, outcome: 'aborted' });
  });

  it('does not start the user program when stopped while the runtime is being re-initialized', async () => {
    const executor = await ready();
    // 実行中のプログラムを止めると、次の run は runtime を作り直してから始まる
    sdk.holds.add('program');
    const stopped = executor.run('while(1);', collectCallbacks().callbacks);
    await sdk.reached('program');
    executor.abort();
    await stopped;
    expect(executor.isRuntimeCorrupted()).toBe(true);
    sdk.holds = new Set(['ready']);

    const running = executor.run('int main(void){ return 0; }', collectCallbacks().callbacks);
    const release = await sdk.reached('ready');
    executor.abort();
    release();
    const result = await running;

    expect(sdk.programSpawns).toBe(1);
    expect(sdk.sandboxFiles).toHaveLength(1);
    expect(result).toMatchObject({ success: false, outcome: 'aborted' });
  });
});

describe('run ownership across a stop and an immediate re-run (#711)', () => {
  /** 1 本目をコンパイル中に止め (SDK はコンパイラを殺せない)、2 本目をプログラムの実行中まで進める */
  async function stopFirstThenStartSecond() {
    const executor = await readyExecutor();
    const first = collectCallbacks();
    const second = collectCallbacks();
    sdk.holds.add('compile');
    sdk.killIgnored = true;

    const firstRun = executor.run('int main(void){ return 0; }', first.callbacks);
    const releaseFirstCompile = await sdk.reached('compile');
    executor.abort();

    sdk.stdoutChunks = [encode('second\n')];
    sdk.holds.add('program');
    const secondRun = executor.run('int main(void){ puts("second"); }', second.callbacks);
    (await sdk.reached('compile'))(0);
    const releaseSecondProgram = await sdk.reached('program');
    sdk.killIgnored = false;

    return { executor, first, second, firstRun, secondRun, releaseFirstCompile, releaseSecondProgram };
  }

  it('lets the re-run succeed while the stopped run finishes late without starting its program', async () => {
    const { first, second, firstRun, secondRun, releaseFirstCompile, releaseSecondProgram } =
      await stopFirstThenStartSecond();

    releaseFirstCompile(0);
    const firstResult = await firstRun;
    releaseSecondProgram(0);
    const secondResult = await secondRun;

    expect(firstResult).toMatchObject({ success: false, outcome: 'aborted' });
    expect(secondResult).toEqual({ success: true, exitCode: 0, stdout: '', stderr: '' });
    expect(sdk.programSpawns).toBe(1);
    expect(first.out.stdout).toBe('');
    expect(second.out.stdout).toBe('second\n');
  });

  it('keeps the re-run stoppable after the stopped run releases its own resources', async () => {
    const { executor, secondRun, firstRun, releaseFirstCompile } = await stopFirstThenStartSecond();

    releaseFirstCompile(0);
    await firstRun;
    executor.abort();
    const secondResult = await secondRun;

    expect(sdk.killed).toBe(2);
    expect(secondResult.exitCode).toBe(137);
  });

  it('does not let a late runtime error of the stopped run mark the re-run runtime as corrupted', async () => {
    const { executor, first, second, firstRun, secondRun, releaseFirstCompile, releaseSecondProgram } =
      await stopFirstThenStartSecond();

    releaseFirstCompile(new Error('RuntimeError: unreachable'));
    const firstResult = await firstRun;
    releaseSecondProgram(0);
    await secondRun;

    expect(firstResult).toMatchObject({ success: false, outcome: 'aborted' });
    expect(executor.isRuntimeCorrupted()).toBe(false);
    expect(first.out.stderr).toBe('');
    expect(second.out.stderr).toBe('');
  });

  it('reports a stopped program as aborted even if it still exits with 0 afterwards', async () => {
    const executor = await readyExecutor();
    sdk.holds.add('program');
    sdk.killIgnored = true;

    const running = executor.run('int main(void){ return 0; }', collectCallbacks().callbacks);
    const release = await sdk.reached('program');
    executor.abort();
    release(0);
    const result = await running;

    expect(result).toMatchObject({ success: false, outcome: 'aborted' });
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

/**
 * コンパイラの診断 (#708)。文言は Issue に実測として書かれた Clang 16 の出力に合わせる。
 * clang は `/workspace/main.c` を渡されるので、実際の行頭はパス付きになる。
 */
const FORMAT_WARNING = `/workspace/main.c:3:24: warning: format specifies type 'int' but the argument has type 'char *' [-Wformat]
    if (0) printf("%d", "oops");
                  ~~    ^~~~~~
                  %s
1 warning generated.
`;
const FATAL_ERROR = `/workspace/main.c:2:10: fatal error: 'student.h' file not found
#include "student.h"
         ^~~~~~~~~~~
1 error generated.
`;

describe('compiler diagnostics (#708)', () => {
  it('forwards compiler warnings once on a successful compile and still reports the run as a success', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    const onStderr = vi.spyOn(callbacks, 'onStderr');
    sdk.compile = { exitCode: 0, stdout: '', stderr: FORMAT_WARNING };
    sdk.stdoutChunks = [new TextEncoder().encode('ran despite warning\n')];

    const result = await executor.run('int main(void){}', callbacks);

    expect(onStderr).toHaveBeenCalledTimes(1);
    expect(out.stderr).toBe(FORMAT_WARNING);
    expect(out.stdout).toBe('ran despite warning\n');
    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(sdk.commands).toHaveLength(2);
  });

  it('forwards the diagnostics of a failed compile to the terminal exactly once', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    const onStderr = vi.spyOn(callbacks, 'onStderr');
    sdk.compile = { exitCode: 1, stdout: '', stderr: FATAL_ERROR };

    const result = await executor.run('#include "student.h"', callbacks);

    expect(onStderr).toHaveBeenCalledTimes(1);
    expect(out.stderr).toBe(FATAL_ERROR);
    expect(result).toMatchObject({ success: false, exitCode: 1, stderr: FATAL_ERROR, error: 'Compilation failed' });
  });

  it('does not write to the terminal when a successful compile prints nothing', async () => {
    const executor = await readyExecutor();
    const { callbacks } = collectCallbacks();
    const onStderr = vi.spyOn(callbacks, 'onStderr');

    await executor.run('int main(void){return 0;}', callbacks);

    expect(onStderr).not.toHaveBeenCalled();
  });

  it('marks a fatal error as an error at its line and column', () => {
    expect(new CExecutor().parseErrors(FATAL_ERROR)).toEqual([
      { line: 2, column: 10, severity: 'error', message: "'student.h' file not found" },
    ]);
  });

  it('keeps parsing error, warning and note diagnostics alongside a fatal error in one output', () => {
    const stderr = [
      "main.c:4:5: error: use of undeclared identifier 'x'",
      "main.c:3:24: warning: format specifies type 'int' but the argument has type 'char *' [-Wformat]",
      'main.c:1:5: note: previous definition is here',
      "main.c:2:10: fatal error: 'student.h' file not found",
    ].join('\n');

    expect(new CExecutor().parseErrors(stderr).map((e) => [e.severity, e.line, e.column])).toEqual([
      ['error', 4, 5],
      ['warning', 3, 24],
      ['note', 1, 5],
      ['error', 2, 10],
    ]);
  });

  it('reads the warning of a successful compile at its user-source line', () => {
    expect(new CExecutor().parseErrors(FORMAT_WARNING)).toEqual([
      {
        line: 3,
        column: 24,
        severity: 'warning',
        message: "format specifies type 'int' but the argument has type 'char *' [-Wformat]",
      },
    ]);
  });

  it('forwards and parses C++ diagnostics from main.cpp the same way', async () => {
    const executor = new CppExecutor();
    await executor.initialize();
    const { out, callbacks } = collectCallbacks();
    const onStderr = vi.spyOn(callbacks, 'onStderr');
    const cppWarning =
      "/workspace/main.cpp:2:9: warning: unused variable 'n' [-Wunused-variable]\n1 warning generated.\n";
    const cppFatal = "/workspace/main.cpp:1:10: fatal error: 'student.hpp' file not found\n";
    sdk.compile = { exitCode: 0, stdout: '', stderr: cppWarning };

    const result = await executor.run('int main(){ int n; }', callbacks);

    expect(onStderr).toHaveBeenCalledTimes(1);
    expect(out.stderr).toBe(cppWarning);
    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(executor.parseErrors(cppWarning)).toEqual([
      { line: 2, column: 9, severity: 'warning', message: "unused variable 'n' [-Wunused-variable]" },
    ]);
    expect(executor.parseErrors(cppFatal)).toEqual([
      { line: 1, column: 10, severity: 'error', message: "'student.hpp' file not found" },
    ]);
  });

  it('does not forward the diagnostics of a run stopped during compilation, even if the compiler finishes with warnings (#711)', async () => {
    const executor = await readyExecutor();
    const { out, callbacks } = collectCallbacks();
    sdk.compile = { exitCode: 0, stdout: '', stderr: FORMAT_WARNING };
    sdk.holds.add('compile');
    // SDK がコンパイラを殺せず、警告付きで完了まで走る場合
    sdk.killIgnored = true;

    const running = executor.run('int main(void){}', callbacks);
    const release = await sdk.reached('compile');
    executor.abort();
    release(0);
    const result = await running;

    expect(out.stderr).toBe('');
    expect(result).toMatchObject({ success: false, outcome: 'aborted' });
  });
});

describe.each([
  ['C', () => new CExecutor()],
  ['C++', () => new CppExecutor()],
])('non-interactive %s run (#802)', (_language, create) => {
  async function ready() {
    const executor = create();
    await executor.initialize();
    return executor;
  }

  it('writes the whole stdin to the program and then closes it to send EOF', async () => {
    const executor = await ready();

    await executor.run('int main(void){}', collectCallbacks().callbacks, { stdin: '3\n1 8 4\n' });

    await vi.waitFor(() => expect(sdk.stdinLog).toEqual(['write:3\n1 8 4\n', 'close']));
  });

  it('does not hand the stdin stream to the caller when stdin is given', async () => {
    const executor = await ready();
    const { out, callbacks } = collectCallbacks();

    await executor.run('int main(void){}', callbacks, { stdin: '' });

    expect(out.stdin).toBeNull();
  });

  it('reports the start of the user program once, after it has been spawned', async () => {
    const executor = await ready();
    const starts: string[] = [];
    const { callbacks } = collectCallbacks();

    await executor.run('int main(void){}', { ...callbacks, onProgramStart: () => starts.push(sdk.entered.join(',')) });

    expect(starts).toEqual(['sandbox,compile,readFile,install,program']);
  });
});

describe.each([
  ['C', () => new CExecutor()],
  ['C++', () => new CppExecutor()],
])('interactive %s stdin (#707)', (_language, create) => {
  it('passes the committed lines to the program pipe in order and sends EOF on close, ignoring lines after it', async () => {
    const executor = create();
    await executor.initialize();
    sdk.holds.add('program');
    const { out, callbacks } = collectCallbacks();
    const running = executor.run('int main(void){}', callbacks);
    const release = await sdk.reached('program');

    out.stdin?.writeLine('13\n');
    out.stdin?.writeLine('日本\n');
    out.stdin?.close();
    out.stdin?.writeLine('late\n');
    out.stdin?.close();

    await vi.waitFor(() => expect(sdk.stdinLog).toEqual(['write:13\n', 'write:日本\n', 'close']));
    release(0);
    expect(await running).toMatchObject({ success: true });
  });
});

describe('pipeInteractiveStdin (#707)', () => {
  /** write が手で解決されるまで終わらない stdin (遅い pipe) */
  function slowPipe() {
    const log: string[] = [];
    const pending: (() => void)[] = [];
    const stdin = {
      write: (data: string) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            log.push(`write:${data}`);
            resolve();
          });
        }),
      close: async () => {
        log.push('close');
      },
    };
    return { stdin: stdin as unknown as WritableBytes, log, finishNextWrite: () => pending.shift()?.() };
  }

  it('closes the pipe only after the lines written before close have been delivered', async () => {
    const pipe = slowPipe();
    const stdin = pipeInteractiveStdin(pipe.stdin);

    stdin.writeLine('a\n');
    stdin.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 書き込みが終わるまで close しない (先に閉じると、プログラムが行を読む前に EOF になる)
    expect(pipe.log).toEqual([]);

    pipe.finishNextWrite();
    await vi.waitFor(() => expect(pipe.log).toEqual(['write:a\n', 'close']));
  });

  it('keeps delivering later lines after a write fails because the program stopped reading', async () => {
    const log: string[] = [];
    let failNext = true;
    const stdin = pipeInteractiveStdin({
      write: async (data: string) => {
        if (failNext) {
          failNext = false;
          throw new Error('broken pipe');
        }
        log.push(`write:${data}`);
      },
      close: async () => {
        log.push('close');
      },
    } as unknown as WritableBytes);

    stdin.writeLine('lost\n');
    stdin.writeLine('kept\n');
    stdin.close();

    await vi.waitFor(() => expect(log).toEqual(['write:kept\n', 'close']));
  });
});
