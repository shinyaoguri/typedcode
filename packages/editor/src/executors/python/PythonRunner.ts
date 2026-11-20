/**
 * Python の runner (opaque origin の sandbox iframe + その中の Worker) の親の側 (#719 / #650)。
 *
 * PythonExecutor は Worker と同じ形 (postMessage / terminate / onmessage / onerror) でこれを使う。
 * 寿命は Executor が決める: 初期化で作り、実行をまたいで保ち、停止・タイムアウト・異常で terminate
 * (iframe を除去 = Worker ごと止まる) して、次の実行で作り直す。
 *
 * - 受け取るのは `e.source === iframe.contentWindow` かつ `e.origin === 'null'` (opaque origin) で、
 *   `parsePythonRunnerMessage` の検査 (runnerId・type・型・長さ) を通ったものだけ
 * - runner の準備応答 (`runner-ready`) が来るまで、送る要求は貯めておく
 * - fail closed: runner が cross-origin isolated でない・準備応答が上限までに来ない・`fatal` は、
 *   iframe を除去して onerror で知らせる。同じ origin の Worker での実行へは戻さない
 * - 親から渡すのはコード・パッケージ名・stdin の行だけ (pythonRunnerProtocol.ts)
 *
 * DOM への依存は `PythonRunnerHost` に閉じてあり、ユニットテストは偽の host を渡す。
 */

import { getExecutionLimits } from '../sandbox/limits.js';
import { buildPythonRunnerSrcdoc, PYTHON_RUNNER_IFRAME_ALLOW, PYTHON_RUNNER_IFRAME_TOKENS } from './pythonRunnerDocument.js';
import { type PythonExecMessage, type PythonRunnerRequest, parsePythonRunnerMessage } from './pythonRunnerProtocol.js';

/** PythonExecutor が使う runner の形 (テストでは偽物に差し替える) */
export interface PythonRunnerHandle {
  postMessage(message: PythonRunnerRequest): void;
  terminate(): void;
  /** 検査を通ったメッセージ */
  onmessage: ((message: PythonExecMessage) => void) | null;
  /** runner の異常 (準備応答が来ない・isolated でない・Worker が落ちた)。受けた時点で runner は止まっている */
  onerror: ((error: string) => void) | null;
}

export interface PythonRunnerTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface PythonRunnerFrame {
  readonly contentWindow: PythonRunnerTarget | null;
  remove(): void;
}

export interface PythonRunnerMessageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

/** PythonRunner が使う環境 (ブラウザでは document / window) */
export interface PythonRunnerHost {
  readonly parentOrigin: string;
  createFrame(srcdoc: string): PythonRunnerFrame;
  addMessageListener(listener: (e: PythonRunnerMessageEvent) => void): void;
  removeMessageListener(listener: (e: PythonRunnerMessageEvent) => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** runner の iframe に付ける印 (E2E が属性と後始末を確かめる) */
export const PYTHON_RUNNER_FRAME_ATTRIBUTE = 'data-python-runner';

/** opaque origin の送り手の `MessageEvent.origin` */
const OPAQUE_ORIGIN = 'null';

export const NOT_ISOLATED_ERROR =
  'The Python runner is not cross-origin isolated, so Python cannot run in this browser.';
export const RUNNER_NOT_STARTED_ERROR = 'The Python runner did not start.';

export const browserPythonRunnerHost: PythonRunnerHost = {
  get parentOrigin() {
    return window.location.origin;
  },
  createFrame(srcdoc: string): PythonRunnerFrame {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', PYTHON_RUNNER_IFRAME_TOKENS);
    iframe.setAttribute('allow', PYTHON_RUNNER_IFRAME_ALLOW);
    iframe.setAttribute(PYTHON_RUNNER_FRAME_ATTRIBUTE, '');
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

function defaultRunnerId(): string {
  return globalThis.crypto.randomUUID();
}

export interface PythonRunnerOptions {
  host?: PythonRunnerHost;
  readyTimeoutMs?: number;
  createRunnerId?: () => string;
  /** runner の Worker のソース (テストで差し替える) */
  workerSource?: string;
}

/** runner の iframe を作り、Worker と同じ形の handle を返す */
export function createPythonRunner(options: PythonRunnerOptions = {}): PythonRunnerHandle {
  const host = options.host ?? browserPythonRunnerHost;
  const readyTimeoutMs = options.readyTimeoutMs ?? getExecutionLimits().readyTimeoutMs;
  const runnerId = (options.createRunnerId ?? defaultRunnerId)();

  let frame: PythonRunnerFrame | null = null;
  let ready = false;
  let stopped = false;
  let readyTimer: unknown = null;
  const queue: PythonRunnerRequest[] = [];

  const send = (request: PythonRunnerRequest): void => {
    frame?.contentWindow?.postMessage({ ...request, runnerId }, '*');
  };

  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    host.removeMessageListener(onMessage);
    if (readyTimer !== null) host.clearTimeout(readyTimer);
    readyTimer = null;
    queue.length = 0;
    try {
      frame?.remove();
    } catch (error) {
      console.error('[PythonRunner] failed to remove the runner frame:', error);
    }
    frame = null;
  };

  const fail = (error: string): void => {
    if (stopped) return;
    shutdown();
    handle.onerror?.(error);
  };

  const onMessage = (e: PythonRunnerMessageEvent): void => {
    if (stopped || !frame) return;
    const target = frame.contentWindow;
    if (!target || e.source !== target || e.origin !== OPAQUE_ORIGIN) return;
    const msg = parsePythonRunnerMessage(e.data, runnerId);
    if (!msg) return;
    switch (msg.type) {
      case 'runner-ready':
        if (ready) return;
        if (!msg.crossOriginIsolated) {
          fail(NOT_ISOLATED_ERROR);
          return;
        }
        ready = true;
        if (readyTimer !== null) host.clearTimeout(readyTimer);
        readyTimer = null;
        for (const request of queue.splice(0)) send(request);
        return;
      case 'fatal':
        fail(msg.message);
        return;
      default:
        if (ready) handle.onmessage?.(msg);
    }
  };

  const handle: PythonRunnerHandle = {
    onmessage: null,
    onerror: null,
    postMessage(request) {
      if (stopped) return;
      if (ready) send(request);
      else queue.push(request);
    },
    terminate: shutdown,
  };

  host.addMessageListener(onMessage);
  readyTimer = host.setTimeout(() => fail(RUNNER_NOT_STARTED_ERROR), readyTimeoutMs);
  try {
    frame = host.createFrame(
      buildPythonRunnerSrcdoc({
        runnerId,
        parentOrigin: host.parentOrigin,
        ...(options.workerSource !== undefined ? { workerSource: options.workerSource } : {}),
      })
    );
  } catch (error) {
    // 呼び出し側が onerror を付ける前なので、次の tick で知らせる
    const message = `Failed to create the Python runner: ${error instanceof Error ? error.message : String(error)}`;
    host.setTimeout(() => fail(message), 0);
  }
  return handle;
}
