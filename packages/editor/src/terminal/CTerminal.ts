/**
 * Terminal module using xterm.js
 * Provides interactive terminal for C program I/O
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export class CTerminal {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private inputBuffer: string = '';
  private inputResolver: ((value: string) => void) | null = null;
  private isWaitingForInput: boolean = false;
  private disposed: boolean = false;

  // Stream connection mode for WASI stdin
  private stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private encoder = new TextEncoder();

  constructor(container: HTMLElement) {

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
        // Forward to stdin (no local echo - WASI program handles echo)
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
    this.terminal.options.disableStdin = true; // Disable input after program ends
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
