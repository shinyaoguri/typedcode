/**
 * Terminal module using xterm.js
 * Provides interactive terminal for C program I/O
 */

import type { CodeExecutionOutcome } from '@typedcode/shared';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { InteractiveStdin } from '../executors/interfaces/ILanguageExecutor.js';
import { StdinLineDiscipline } from './stdinLineDiscipline.js';

/** Callback type for terminal input events */
export type TerminalInputCallback = (input: string) => void;

/**
 * ターミナルの stdin の状態 (#707)。`open` = 入力をプログラムへ渡す、`closed` = EOF を送った後
 * (入力は捨て、Ctrl+C の停止だけ効く)、null = 実行中のプログラムにつながっていない。
 * コンテナの `data-stdin-state` にも出す (状態契約。null のときは属性なし)
 */
export type StdinState = 'open' | 'closed' | null;

export interface ConnectStdinOptions {
  /** 選択の無い Ctrl+C で呼ぶ (実行を止める。#707) */
  onInterrupt?: () => void;
}

export class CTerminal {
  private terminal: Terminal;
  private readonly container: HTMLElement;
  private fitAddon: FitAddon;
  private inputBuffer: string = '';
  private inputResolver: ((value: string) => void) | null = null;
  private isWaitingForInput: boolean = false;
  private disposed: boolean = false;

  // 対話の実行の stdin (#707)。行の編集はここ (line discipline) で行い、確定した行だけをプログラムに渡す
  private stdin: InteractiveStdin | null = null;
  private stdinClosed = false;
  private onInterrupt: (() => void) | null = null;
  private stdinStateListener: ((state: StdinState) => void) | null = null;

  // 打った・貼った入力を 1 文字ずつ行に区切る。確定した行を、プログラムの stdin と inputCallback
  // (terminalInput の記録) の両方に同じ文字列で渡す (Python と共有の line discipline)
  private lineDiscipline = new StdinLineDiscipline();

  // Callback for input events (called when user presses Enter)
  private inputCallback: TerminalInputCallback | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    container.dataset.execState = 'idle';
    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      disableStdin: true, // Disable input by default, enable when program is running
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#d7ba7d',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#6a9955',
        brightYellow: '#d7ba7d',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0',
        brightWhite: '#ffffff',
      },
      scrollback: 1000,
      convertEol: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    this.terminal.open(container);
    this.fit();

    // Ctrl+C は選択があればコピーを優先し、xterm に `\x03` を送らせない (選択が無ければ onData の停止へ。#707)
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (!isCopyShortcut(event) || !this.terminal.hasSelection()) return true;
      if (event.type === 'keydown') {
        const selection = this.terminal.getSelection();
        // コピーは記録しない (SessionContentRegistry に登録しない。問題の例のコピーと同じ扱い)
        void navigator.clipboard?.writeText(selection).catch(() => {});
        // 次の Ctrl+C が停止になるよう選択を外す (多くの端末と同じ)
        this.terminal.clearSelection();
      }
      return false;
    });

    // Handle user input
    this.terminal.onData((data) => {
      if (this.stdin) {
        this.handleStdinData(data);
        return;
      }

      // Ignore all input when not in any input mode
      // (neither stdin connected nor waitForInput active)
      if (!this.isWaitingForInput) return;

      // Handle special keys
      if (data === '\r') {
        // Enter key - submit input
        this.terminal.write('\r\n');
        const input = this.inputBuffer;
        this.inputBuffer = '';
        if (this.inputResolver) {
          const resolver = this.inputResolver;
          this.inputResolver = null;
          this.isWaitingForInput = false;
          resolver(input);
        }
      } else if (data === '\x7f') {
        // Backspace
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.terminal.write('\b \b');
        }
      } else if (data === '\x03') {
        // Ctrl+C - cancel input
        this.terminal.write('^C\r\n');
        this.inputBuffer = '';
        if (this.inputResolver) {
          const resolver = this.inputResolver;
          this.inputResolver = null;
          this.isWaitingForInput = false;
          resolver('');
        }
      } else if (data >= ' ' || data === '\t') {
        // Regular printable character
        this.inputBuffer += data;
        this.terminal.write(data);
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (!this.disposed) {
        this.fit();
      }
    });
    resizeObserver.observe(container);
  }

  /**
   * コード実行の状態契約 (#290。packages/editor/AGENTS.md「状態契約」): 実行を始めた。
   * `data-exec-state="running"`・`data-exec-run=<run の通し番号>` を付け、前の結果 (`data-exec-outcome`) を外す
   */
  markRunStarted(runId: number): void {
    this.container.dataset.execState = 'running';
    this.container.dataset.execRun = String(runId);
    delete this.container.dataset.execOutcome;
  }

  /** コード実行の状態契約: 実行が終わった。`data-exec-state="idle"` と結果 `data-exec-outcome` を付ける */
  markRunFinished(outcome: CodeExecutionOutcome): void {
    this.container.dataset.execState = 'idle';
    this.container.dataset.execOutcome = outcome;
  }

  /**
   * Write text to terminal
   */
  write(text: string): void {
    if (this.disposed) return;
    this.terminal.write(text);
  }

  /**
   * Write a line to terminal
   */
  writeLine(text: string): void {
    if (this.disposed) return;
    this.terminal.writeln(text);
  }

  /**
   * Write error text (in red)
   */
  writeError(text: string): void {
    if (this.disposed) return;
    this.terminal.write('\x1b[31m' + text + '\x1b[0m');
  }

  /**
   * Write success text (in green)
   */
  writeSuccess(text: string): void {
    if (this.disposed) return;
    this.terminal.write('\x1b[32m' + text + '\x1b[0m');
  }

  /**
   * Write info text (in blue)
   */
  writeInfo(text: string): void {
    if (this.disposed) return;
    this.terminal.write('\x1b[34m' + text + '\x1b[0m');
  }

  /**
   * Clear the terminal
   */
  clear(): void {
    if (this.disposed) return;
    this.terminal.clear();
    this.terminal.reset();
  }

  /**
   * Wait for user input
   * Returns a promise that resolves when user presses Enter
   */
  async waitForInput(): Promise<string> {
    if (this.disposed) return '';

    return new Promise((resolve) => {
      this.isWaitingForInput = true;
      this.inputBuffer = '';
      this.inputResolver = resolve;
      this.terminal.focus();
    });
  }

  /**
   * Cancel any pending input
   */
  cancelInput(): void {
    if (this.inputResolver) {
      const resolver = this.inputResolver;
      this.inputResolver = null;
      this.isWaitingForInput = false;
      resolver('');
    }
  }

  /**
   * 実行中のプログラムの stdin につなぐ (#707)。以後の入力は line discipline で行にまとめ、
   * エコーはここでターミナルに書き、確定した行だけを stdin と inputCallback に渡す
   */
  connectStdin(stdin: InteractiveStdin, options: ConnectStdinOptions = {}): void {
    if (this.disposed) return;
    this.stdin = stdin;
    this.stdinClosed = false;
    this.onInterrupt = options.onInterrupt ?? null;
    this.lineDiscipline = new StdinLineDiscipline();
    this.terminal.options.disableStdin = false; // Enable input
    this.setStdinState('open');
    this.terminal.focus();
  }

  /**
   * Disconnect from the stdin stream
   */
  disconnectStdin(): void {
    this.stdin = null;
    this.stdinClosed = false;
    this.onInterrupt = null;
    this.lineDiscipline = new StdinLineDiscipline(); // Clear line buffer
    this.terminal.options.disableStdin = true; // Disable input after program ends
    this.setStdinState(null);
  }

  /**
   * 「入力終了」(#707): 書きかけの行があれば LF 付きで確定して渡してから、stdin を閉じる (EOF)。
   * つながっていない・閉じた後は何もしない
   */
  endInput(): void {
    if (!this.stdin || this.stdinClosed) return;
    const pending = this.lineDiscipline.flush();
    if (pending !== null) {
      this.terminal.write('\n');
      this.commitLine(pending);
    }
    this.closeStdin();
  }

  /** stdin の状態 (#707)。null = 実行中のプログラムにつながっていない */
  getStdinState(): StdinState {
    if (!this.stdin) return null;
    return this.stdinClosed ? 'closed' : 'open';
  }

  /** stdin の状態が変わるたびに呼ぶ (「入力終了」ボタンの表示に使う。#707) */
  setStdinStateListener(listener: ((state: StdinState) => void) | null): void {
    this.stdinStateListener = listener;
  }

  /**
   * stdin につながっている間の入力 (xterm の onData 1 回分)。貼り付けは `"3\r5\r"` のような塊で
   * 1 回に届くので、line discipline が 1 文字ずつ処理する (#648)。確定した行は stdin と記録に同じ文字列で渡し、
   * 空の行の Ctrl+D で閉じ、Ctrl+C で止める (#707)。閉じた後は Ctrl+C だけを見る
   */
  private handleStdinData(data: string): void {
    if (this.stdinClosed) {
      if (data.includes('\x03')) this.onInterrupt?.();
      return;
    }
    const { echo, lines, eof, interrupt } = this.lineDiscipline.feed(data);
    if (echo) this.terminal.write(echo);
    for (const line of lines) this.commitLine(line);
    if (interrupt) {
      this.onInterrupt?.();
      return;
    }
    if (eof) this.closeStdin();
  }

  /** 確定した行 (末尾の "\n" 込み) をプログラムへ渡し、空でなければ inputCallback に記録させる */
  private commitLine(line: string): void {
    this.stdin?.writeLine(line);
    const text = line.slice(0, -1); // 確定した行の末尾の "\n" を外す
    if (this.inputCallback && text.length > 0) this.inputCallback(text);
  }

  private closeStdin(): void {
    if (!this.stdin || this.stdinClosed) return;
    this.stdinClosed = true;
    this.stdin.close();
    this.setStdinState('closed');
  }

  private setStdinState(state: StdinState): void {
    if (state) this.container.dataset.stdinState = state;
    else delete this.container.dataset.stdinState;
    this.stdinStateListener?.(state);
  }

  /**
   * Set callback for terminal input events
   * Called when user presses Enter with the complete line
   */
  setInputCallback(callback: TerminalInputCallback | null): void {
    this.inputCallback = callback;
  }

  /**
   * Check if stdin stream is connected
   */
  isStdinConnected(): boolean {
    return this.stdin !== null;
  }

  /**
   * Check if terminal is waiting for input
   */
  isInputPending(): boolean {
    return this.isWaitingForInput;
  }

  /**
   * Fit terminal to container size
   */
  fit(): void {
    if (this.disposed) return;
    try {
      this.fitAddon.fit();
    } catch {
      // Ignore fit errors when container is not visible
    }
  }

  /**
   * Focus the terminal
   */
  focus(): void {
    if (this.disposed) return;
    this.terminal.focus();
  }

  /**
   * Dispose the terminal
   */
  dispose(): void {
    this.disposed = true;
    this.cancelInput();
    this.terminal.dispose();
  }

  /**
   * Get the underlying xterm Terminal instance
   */
  getTerminal(): Terminal {
    return this.terminal;
  }
}

/** コピーのキー (Ctrl+C。Shift / Alt / Meta との組み合わせは除く。macOS の Cmd+C はブラウザ既定のコピー) */
function isCopyShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c';
}
