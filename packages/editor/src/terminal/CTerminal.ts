/**
 * Terminal module using xterm.js
 * Provides interactive terminal for C program I/O
 */

import type { CodeExecutionOutcome } from '@typedcode/shared';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { StdinLineDiscipline } from './stdinLineDiscipline.js';

/** Callback type for terminal input events */
export type TerminalInputCallback = (input: string) => void;

export class CTerminal {
  private terminal: Terminal;
  private readonly container: HTMLElement;
  private fitAddon: FitAddon;
  private inputBuffer: string = '';
  private inputResolver: ((value: string) => void) | null = null;
  private isWaitingForInput: boolean = false;
  private disposed: boolean = false;

  // Stream connection mode for WASI stdin
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private encoder = new TextEncoder();

  // stdin モードで打った・貼った入力を行に区切って inputCallback (terminalInput の記録) に渡すための行バッファ。
  // エコーは WASI 側がするので、ここでは確定した行だけを使う (Python と同じ line discipline で 1 文字ずつ処理する)
  private stdinLineLog = new StdinLineDiscipline();

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

    // Handle user input
    this.terminal.onData((data) => {
      // Stream connection mode: forward input directly to WASI stdin
      if (this.stdinWriter) {
        this.logStdinLines(data);

        // Forward to stdin as one chunk (no local echo - WASI program handles echo)
        this.stdinWriter.write(this.encoder.encode(data)).catch(() => {
          // Ignore errors when program has ended
        });
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
   * Connect to a WASI program's stdin stream
   * In this mode, user input is forwarded directly to the stream
   */
  connectStdin(stdinStream: WritableStream<Uint8Array>): void {
    if (this.disposed) return;
    this.stdinWriter = stdinStream.getWriter();
    this.terminal.options.disableStdin = false; // Enable input
    this.terminal.focus();
  }

  /**
   * Disconnect from the stdin stream
   */
  disconnectStdin(): void {
    if (this.stdinWriter) {
      try {
        this.stdinWriter.releaseLock();
      } catch {
        // Ignore errors if stream is already closed
      }
      this.stdinWriter = null;
    }
    this.stdinLineLog = new StdinLineDiscipline(); // Clear line buffer
    this.terminal.options.disableStdin = true; // Disable input after program ends
  }

  /**
   * stdin モードの入力 (xterm の onData 1 回分) を行に区切り、確定した空でない行ごとに inputCallback を呼ぶ。
   * 貼り付けは `"3\r5\r"` のような塊で 1 回に届くので、塊のまま判定せず 1 文字ずつ処理する (#648)。
   * Enter (`\r` / `\n`) で確定、バックスペースで 1 文字消す、Ctrl+C (`\x03`) で書きかけの行を捨てる。
   */
  private logStdinLines(data: string): void {
    const segments = data.split('\x03');
    segments.forEach((segment, index) => {
      if (index > 0) this.stdinLineLog = new StdinLineDiscipline(); // Ctrl+C - clear buffer
      for (const line of this.stdinLineLog.feed(segment).lines) {
        const text = line.slice(0, -1); // 確定した行の末尾の "\n" を外す
        if (this.inputCallback && text.length > 0) this.inputCallback(text);
      }
    });
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
    return this.stdinWriter !== null;
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
