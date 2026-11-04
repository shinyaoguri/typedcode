/**
 * ユーザーの JS を opaque origin の sandbox iframe の中の Worker で実行する (#290 / ADR-0041)。
 *
 * 実行ごとに `<iframe sandbox="allow-scripts" hidden srcdoc=runner>` を作り、終わったら iframe ごと
 * 除去する (= Worker の強制終了)。ユーザーコードの協力 (AbortSignal を見る等) を当てにしない。
 *
 * 結果 (outcome) の決まり方:
 * - `success` / `failure`: Worker 内の完了 (`done`)。完了の定義は Node と同じ (workerSource.ts)
 * - `aborted`: `abort()` (停止ボタン)
 * - `timeout`: `timeoutMs` を超えた
 * - `error`: 出力予算の超過 / runner の準備応答が来ない / iframe を作れない / Worker が落ちた
 *
 * 親子通信は postMessage。受け取るのは `e.source === iframe.contentWindow` で、かつ
 * `parseSandboxMessage` の形の検査と runId の一致を通ったものだけ (BrowserPreviewPanel #318 と同じ型)。
 * 終わった run のメッセージは listener ごと外して捨てる (停止後に出力が出ない)。
 *
 * DOM への依存は `SandboxHost` に閉じてあり、ユニットテストは偽の host を渡す。
 */

import type { CodeExecutionOutcome } from '@typedcode/shared';
import { type ExecutionLimits, getExecutionLimits } from './limits.js';
import { parseSandboxMessage, type SandboxRunRequest } from './protocol.js';
import { buildRunnerSrcdoc, SANDBOX_IFRAME_TOKENS } from './runnerDocument.js';

/** postMessage を受けられる相手 (iframe の contentWindow) */
export interface SandboxTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** 1 回の実行に使う iframe */
export interface SandboxFrame {
  readonly contentWindow: SandboxTarget | null;
  remove(): void;
}

/** 受け取ったメッセージのうち、検査に使う部分 */
export interface SandboxMessageEventLike {
  source: unknown;
  data: unknown;
}

/** SandboxRunner が使う環境 (ブラウザでは document / window) */
export interface SandboxHost {
  createFrame(srcdoc: string): SandboxFrame;
  addMessageListener(listener: (e: SandboxMessageEventLike) => void): void;
  removeMessageListener(listener: (e: SandboxMessageEventLike) => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SandboxCallbacks {
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
}

/** sandbox が返す結果の outcome (ADR-0021 の outcome そのもの) */
export type SandboxOutcome = CodeExecutionOutcome;

export interface SandboxResult {
  outcome: SandboxOutcome;
  /** success = 0 / failure = 1。それ以外 (Worker 外で決まった結果) は null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** error のときの理由 (英語固定) */
  error?: string;
}

export interface SandboxRun {
  readonly result: Promise<SandboxResult>;
  /** 実行を止める (iframe を除去して `aborted` で確定する)。終わった run には何もしない */
  abort(): void;
}

/** 実行中の iframe に付ける印 (E2E が「片付いた」ことを確かめる) */
export const SANDBOX_FRAME_ATTRIBUTE = 'data-code-runner';

/** ブラウザの document / window を使う既定の host */
export const browserSandboxHost: SandboxHost = {
  createFrame(srcdoc: string): SandboxFrame {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', SANDBOX_IFRAME_TOKENS);
    iframe.setAttribute(SANDBOX_FRAME_ATTRIBUTE, '');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.hidden = true;
    iframe.srcdoc = srcdoc;
    document.body.appendChild(iframe);
    return {
      get contentWindow() {
        return iframe.contentWindow;
      },
      remove: () => iframe.remove(),
    };
  },
  addMessageListener: (listener) => window.addEventListener('message', listener),
  removeMessageListener: (listener) => window.removeEventListener('message', listener),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

function defaultRunId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 出力予算を超えたときに stderr に一度だけ出す通知 (英語固定。ターミナルの他の system 表示と同じ流儀) */
export function outputLimitNotice(budget: number): string {
  return `\n[System] Output limit exceeded (${budget} characters). Execution stopped.\n`;
}

export interface SandboxRunnerOptions {
  host?: SandboxHost;
  limits?: () => ExecutionLimits;
  createRunId?: () => string;
}

export class SandboxRunner {
  private readonly host: SandboxHost;
  private readonly limits: () => ExecutionLimits;
  private readonly createRunId: () => string;

  constructor(options: SandboxRunnerOptions = {}) {
    this.host = options.host ?? browserSandboxHost;
    this.limits = options.limits ?? getExecutionLimits;
    this.createRunId = options.createRunId ?? defaultRunId;
  }

  /** code を新しい sandbox で実行する。呼ぶたびに独立した iframe と Worker を作る */
  start(code: string, callbacks: SandboxCallbacks): SandboxRun {
    const host = this.host;
    const limits = this.limits();
    const runId = this.createRunId();

    let settled = false;
    let ready = false;
    let frame: SandboxFrame | null = null;
    let readyTimer: unknown = null;
    let timeoutTimer: unknown = null;
    let stdout = '';
    let stderr = '';
    let received = 0;

    let resolveResult!: (r: SandboxResult) => void;
    const result = new Promise<SandboxResult>((resolve) => {
      resolveResult = resolve;
    });

    // 出力先 (ターミナル) の例外で実行の後始末を止めない
    const write = (stream: 'stdout' | 'stderr', text: string): void => {
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      try {
        (stream === 'stdout' ? callbacks.onStdout : callbacks.onStderr)(text);
      } catch (error) {
        console.error('[SandboxRunner] output callback failed:', error);
      }
    };

    const finish = (outcome: SandboxOutcome, exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      host.removeMessageListener(onMessage);
      if (readyTimer !== null) host.clearTimeout(readyTimer);
      if (timeoutTimer !== null) host.clearTimeout(timeoutTimer);
      try {
        frame?.remove();
      } catch (removeError) {
        console.error('[SandboxRunner] failed to remove the runner frame:', removeError);
      }
      frame = null;
      resolveResult({ outcome, exitCode, stdout, stderr, ...(error !== undefined ? { error } : {}) });
    };

    const fail = (message: string): void => {
      write('stderr', `[System] ${message}\n`);
      finish('error', null, message);
    };

    const deliver = (stream: 'stdout' | 'stderr', text: string): void => {
      const budget = limits.outputBudgetChars;
      const room = Math.max(0, budget - received);
      received += text.length;
      const part = text.length > room ? text.slice(0, room) : text;
      if (part.length > 0) write(stream, part);
      if (received > budget) {
        write('stderr', outputLimitNotice(budget));
        finish('error', null, 'Output limit exceeded');
      }
    };

    const onMessage = (e: SandboxMessageEventLike): void => {
      if (settled || !frame) return;
      const target = frame.contentWindow;
      if (!target || e.source !== target) return;
      const msg = parseSandboxMessage(e.data, runId);
      if (!msg) return;
      switch (msg.type) {
        case 'ready': {
          if (ready) return;
          ready = true;
          if (readyTimer !== null) host.clearTimeout(readyTimer);
          readyTimer = null;
          const request: SandboxRunRequest = { type: 'run', runId, code, outputBudgetChars: limits.outputBudgetChars };
          target.postMessage(request, '*');
          return;
        }
        case 'stdout':
        case 'stderr':
          if (ready) deliver(msg.type, msg.text);
          return;
        case 'done':
          if (ready) finish(msg.outcome, msg.exitCode);
          return;
        case 'fatal':
          fail(msg.message);
          return;
      }
    };

    host.addMessageListener(onMessage);
    timeoutTimer = host.setTimeout(() => finish('timeout', null), limits.timeoutMs);
    readyTimer = host.setTimeout(() => {
      if (!ready) fail('The code runner did not start.');
    }, limits.readyTimeoutMs);
    try {
      frame = host.createFrame(buildRunnerSrcdoc(runId));
    } catch (error) {
      fail(`Failed to create the code runner: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      result,
      abort: () => finish('aborted', null),
    };
  }
}
