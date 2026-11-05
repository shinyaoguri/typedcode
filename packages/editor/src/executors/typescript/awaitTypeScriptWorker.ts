/**
 * Monaco の TS worker の取得を、TS の言語モードの登録まで待つ (#624)
 *
 * Monaco の `typescript.getTypeScriptWorker()` は、言語モードの setup より前に呼ぶと
 * `"TypeScript not registered!"` (Error ではなく文字列) で reject する。setup は TS のモデルが初めて
 * 作られたときに `import('./tsMode.js')` の後で走るが、同じ import を待つ `getTypeScriptWorker()` の方が
 * 先に解決することがある (C のタブから TS に切り替えた直後の実行で再現)。登録は少し待てば済むので、
 * 未登録の間だけ取り直す。それ以外の失敗はすぐ投げる。
 *
 * monaco に依存しない純関数にしてあり、ユニットテストは偽の取得関数を渡す。
 */

/** 未登録の間に取り直す間隔 */
export const TS_WORKER_RETRY_INTERVAL_MS = 50;
/** 登録を待つ上限。過ぎたら最後の失敗を投げる (変換は `error` で終わる) */
export const TS_WORKER_REGISTRATION_TIMEOUT_MS = 10_000;

export interface AwaitTypeScriptWorkerOptions {
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `getTypeScriptWorker()` が言語モードの未登録で reject したか */
export function isTypeScriptNotRegistered(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.includes('TypeScript not registered');
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function awaitTypeScriptWorker<T>(
  getTypeScriptWorker: () => Promise<T>,
  options: AwaitTypeScriptWorkerOptions = {}
): Promise<T> {
  const intervalMs = options.intervalMs ?? TS_WORKER_RETRY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? TS_WORKER_REGISTRATION_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return await getTypeScriptWorker();
    } catch (reason) {
      if (!isTypeScriptNotRegistered(reason) || now() >= deadline) throw reason;
      await sleep(intervalMs);
    }
  }
}
