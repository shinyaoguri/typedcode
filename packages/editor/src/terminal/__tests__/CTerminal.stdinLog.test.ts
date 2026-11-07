// @vitest-environment happy-dom
/**
 * CTerminal の stdin モードの入力ログ (#648) のテスト。
 *
 * stdin に繋いでいる間、ターミナルに打った・貼った入力は行ごとに inputCallback に渡り、
 * main.ts がそれを `terminalInput` として proof に記録する。xterm は貼り付けを `"3\r5\r"` のような
 * 塊で 1 回の onData に渡すので、塊のままではなく 1 文字ずつ行に区切ることを固定する。
 * xterm の Terminal は DOM の描画に依存するのでモックし、onData のハンドラを直接呼ぶ。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const xterm = vi.hoisted(() => ({ onData: null as ((data: string) => void) | null }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(): void {}
    focus(): void {}
    clear(): void {}
    dispose(): void {}
    onData(handler: (data: string) => void): void {
      xterm.onData = handler;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

import { CTerminal } from '../CTerminal.js';

interface Harness {
  type: (data: string) => void;
  lines: string[];
  forwarded: string[];
}

function connectedTerminal(): Harness {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
      }
    );
  }
  const terminal = new CTerminal(document.createElement('div'));
  const lines: string[] = [];
  terminal.setInputCallback((line) => lines.push(line));

  const forwarded: string[] = [];
  const decoder = new TextDecoder();
  terminal.connectStdin(
    new WritableStream<Uint8Array>({
      write(chunk) {
        forwarded.push(decoder.decode(chunk));
      },
    })
  );
  return { type: (data) => xterm.onData!(data), lines, forwarded };
}

beforeEach(() => {
  xterm.onData = null;
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

  it('discards the pending line on Ctrl+C', () => {
    const t = connectedTerminal();
    for (const key of ['1', '2', '\x03', '3', '\r']) t.type(key);
    expect(t.lines).toEqual(['3']);
  });

  it('does not put arrow-key escape sequences into the reported line', () => {
    const t = connectedTerminal();
    for (const key of ['a', '\x1b[A', 'b', '\r']) t.type(key);
    expect(t.lines).toEqual(['ab']);
  });

  it('forwards a pasted chunk to the program stdin as one chunk, unchanged', async () => {
    const t = connectedTerminal();
    t.type('3\r5\r');
    await vi.waitFor(() => expect(t.forwarded).toEqual(['3\r5\r']));
  });
});
