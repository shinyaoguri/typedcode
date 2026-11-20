// @vitest-environment happy-dom
/**
 * CTerminal の stdin モード (#648 / #707) のテスト。
 *
 * stdin に繋いでいる間、ターミナルに打った・貼った入力は line discipline で行にまとめ、確定した行を
 * プログラムの stdin (`InteractiveStdin.writeLine`) と inputCallback (main.ts が `terminalInput` として
 * proof に記録する) の両方に同じ文字列で渡す。xterm は貼り付けを `"3\r5\r"` のような塊で 1 回の onData に
 * 渡すので、塊のままではなく 1 文字ずつ行に区切ることも固定する。
 * xterm の Terminal は DOM の描画に依存するのでモックし、onData とキーのハンドラを直接呼ぶ。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractiveStdin } from '../../executors/interfaces/ILanguageExecutor.js';

const xterm = vi.hoisted(() => ({
  onData: null as ((data: string) => void) | null,
  keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
  selection: '',
  written: [] as string[],
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    loadAddon(): void {}
    open(): void {}
    write(text: string): void {
      xterm.written.push(text);
    }
    writeln(): void {}
    focus(): void {}
    clear(): void {}
    dispose(): void {}
    onData(handler: (data: string) => void): void {
      xterm.onData = handler;
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      xterm.keyHandler = handler;
    }
    hasSelection(): boolean {
      return xterm.selection !== '';
    }
    getSelection(): string {
      return xterm.selection;
    }
    clearSelection(): void {
      xterm.selection = '';
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

import { CTerminal, type StdinState } from '../CTerminal.js';

interface Harness {
  terminal: CTerminal;
  container: HTMLElement;
  type: (data: string) => void;
  /** inputCallback に渡った行 (terminalInput の記録) */
  lines: string[];
  /** プログラムの stdin に渡った行と close */
  sent: string[];
  interrupts: number;
  states: StdinState[];
}

function connectedTerminal(): Harness {
  const container = document.createElement('div');
  const terminal = new CTerminal(container);
  const h: Harness = {
    terminal,
    container,
    type: (data) => xterm.onData!(data),
    lines: [],
    sent: [],
    interrupts: 0,
    states: [],
  };
  terminal.setInputCallback((line) => h.lines.push(line));
  terminal.setStdinStateListener((state) => h.states.push(state));
  const stdin: InteractiveStdin = {
    writeLine: (line) => h.sent.push(line),
    close: () => h.sent.push('<EOF>'),
  };
  terminal.connectStdin(stdin, {
    onInterrupt: () => {
      h.interrupts++;
    },
  });
  return h;
}

/** xterm のキーハンドラに Ctrl+C の keydown を渡し、xterm に処理させるか (true) を返す */
function pressCtrlC(): boolean {
  return xterm.keyHandler!(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
}

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  xterm.onData = null;
  xterm.keyHandler = null;
  xterm.selection = '';
  xterm.written = [];
  writeText.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
    }
  );
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CTerminal stdin input log', () => {
  it('reports each line of a multi-line paste delivered in one onData chunk separately', () => {
    const t = connectedTerminal();
    t.type('3\r5\r');
    expect(t.lines).toEqual(['3', '5']);
  });

  it('reports a CRLF paste as one line per row without an extra empty line', () => {
    const t = connectedTerminal();
    t.type('3 5\r\n7 9\r\n');
    expect(t.lines).toEqual(['3 5', '7 9']);
  });

  it('keeps the unterminated tail of a paste until Enter completes it', () => {
    const t = connectedTerminal();
    t.type('3\r5');
    expect(t.lines).toEqual(['3']);
    t.type('\r');
    expect(t.lines).toEqual(['3', '5']);
  });

  it('reports a line typed key by key once Enter is pressed alone', () => {
    const t = connectedTerminal();
    for (const key of ['4', '2', '\r']) t.type(key);
    expect(t.lines).toEqual(['42']);
  });

  it('does not report an empty line for Enter on an empty buffer', () => {
    const t = connectedTerminal();
    t.type('\r');
    expect(t.lines).toEqual([]);
  });

  it('removes the last character on backspace before the line is reported', () => {
    const t = connectedTerminal();
    for (const key of ['1', '2', '\x7f', '3', '\r']) t.type(key);
    expect(t.lines).toEqual(['13']);
  });

  it('does not put arrow-key escape sequences into the reported line', () => {
    const t = connectedTerminal();
    for (const key of ['a', '\x1b[A', 'b', '\r']) t.type(key);
    expect(t.lines).toEqual(['ab']);
  });
});

describe('CTerminal stdin line editing (#707)', () => {
  it('sends the program the edited line ending in LF, the same line the input log records', () => {
    const t = connectedTerminal();
    for (const key of ['1', '2', '\x7f', '3', '\r', '\r', '日本語', '\x7f', '\r']) t.type(key);
    t.type('3 5\r');
    expect(t.sent).toEqual(['13\n', '\n', '日本\n', '3 5\n']);
    // 記録は空行を除いた同じ行 (#648)
    expect(t.lines).toEqual(['13', '日本', '3 5']);
  });

  it('echoes the typed characters, backspace erasure and the line break on the terminal', () => {
    const t = connectedTerminal();
    xterm.written = [];
    for (const key of ['a', 'b', '\x7f', '\r']) t.type(key);
    expect(xterm.written.join('')).toBe('ab\b \b\n');
  });

  it('closes stdin on Ctrl+D on an empty line and exposes the closed state', () => {
    const t = connectedTerminal();
    expect(t.container.dataset.stdinState).toBe('open');
    t.type('x\r');
    t.type('\x04');
    expect(t.sent).toEqual(['x\n', '<EOF>']);
    expect(t.container.dataset.stdinState).toBe('closed');
    expect(t.terminal.getStdinState()).toBe('closed');
    expect(t.states).toEqual(['open', 'closed']);
  });

  it('only commits a pending line on Ctrl+D and closes on the next Ctrl+D', () => {
    const t = connectedTerminal();
    t.type('ab');
    t.type('\x04');
    expect(t.sent).toEqual(['ab\n']);
    expect(t.container.dataset.stdinState).toBe('open');
    t.type('\x04');
    expect(t.sent).toEqual(['ab\n', '<EOF>']);
  });

  it('commits the pending line before closing stdin on end input', () => {
    const t = connectedTerminal();
    t.type('cd');
    t.terminal.endInput();
    expect(t.sent).toEqual(['cd\n', '<EOF>']);
    expect(t.lines).toEqual(['cd']);
    expect(t.container.dataset.stdinState).toBe('closed');
  });

  it('sends and records nothing typed after stdin is closed, and closes only once', () => {
    const t = connectedTerminal();
    t.type('\x04');
    t.type('late\r');
    t.type('\x04');
    t.terminal.endInput();
    expect(t.sent).toEqual(['<EOF>']);
    expect(t.lines).toEqual([]);
  });

  it('removes the stdin state when the program ends', () => {
    const t = connectedTerminal();
    t.terminal.disconnectStdin();
    expect(t.container.dataset.stdinState).toBeUndefined();
    expect(t.terminal.getStdinState()).toBeNull();
    expect(t.states).toEqual(['open', null]);
    // つながっていない間の「入力終了」は何もしない
    t.terminal.endInput();
    expect(t.sent).toEqual([]);
  });
});

describe('CTerminal Ctrl+C (#707)', () => {
  it('interrupts the run on Ctrl+C without a selection and discards the pending line', () => {
    const t = connectedTerminal();
    expect(pressCtrlC()).toBe(true); // 選択が無ければ xterm に `\x03` を送らせる
    t.type('12');
    t.type('\x03');
    expect(t.interrupts).toBe(1);
    expect(t.sent).toEqual([]);
    expect(t.lines).toEqual([]);
  });

  it('still interrupts the run on Ctrl+C after stdin is closed', () => {
    const t = connectedTerminal();
    t.type('\x04');
    t.type('\x03');
    expect(t.interrupts).toBe(1);
  });

  it('copies the selection on Ctrl+C instead of interrupting, and clears the selection', () => {
    const t = connectedTerminal();
    xterm.selection = 'hello-42';
    expect(pressCtrlC()).toBe(false); // xterm に `\x03` を送らせない
    expect(writeText).toHaveBeenCalledWith('hello-42');
    expect(t.interrupts).toBe(0);
    expect(xterm.selection).toBe('');
  });

  it('copies the selection on Ctrl+C even when no program is running', () => {
    new CTerminal(document.createElement('div'));
    xterm.selection = 'output';
    expect(pressCtrlC()).toBe(false);
    expect(writeText).toHaveBeenCalledWith('output');
  });

  it('leaves Ctrl+Shift+C and other keys to xterm even with a selection', () => {
    connectedTerminal();
    xterm.selection = 'x';
    expect(xterm.keyHandler!(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(xterm.keyHandler!(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});
