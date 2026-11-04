/**
 * fake-indexeddb への障害注入 (#543)。テストから共有する (`*.test.ts` ではないので収集されない)。
 */

import { IDBObjectStore } from 'fake-indexeddb';

type WriteMethod = 'add' | 'put' | 'delete' | 'clear';

export interface InjectedAbort {
  /** abort した transaction の数 (注入が空振りしていないことを見る) */
  aborted(): number;
  /** 元の prototype に戻す */
  restore(): void;
}

/**
 * 書き込みの request が success した後に、その transaction を abort させる
 * (容量切れなどで commit の時点で失敗する、の再現)。
 *
 * request の `onsuccess` は呼び出し側が request を受け取った直後に同期で設定するので、microtask で
 * それを包み直し、呼び出し側のハンドラを走らせてから abort する。abort を先にすると、同じ transaction に
 * 次の request を足すハンドラ (`appendEvent` の tabs 行の更新) が終わった transaction に触って throw し、
 * 「commit 時に失敗した」とは別の壊れ方になる。fake-indexeddb は `on*` のハンドラを addEventListener の
 * リスナーより後に呼ぶので、リスナーを足すのではなくハンドラを包む。
 *
 * 包むのは transaction の最後の request にする (`appendEvent` なら tabs 行の `put`)。最後の request の後なら
 * 待ちの request が無く、`error` は来ずに `abort` だけが来る (commit 時の失敗と同じ形)。途中の request の後に
 * abort すると、待ちの request の AbortError が `error` として bubble するので、`onabort` を待たない実装でも
 * reject してしまい、検査にならない。
 */
export function abortTransactionsAfterWriteSuccess(methods: WriteMethod[]): InjectedAbort {
  const proto = IDBObjectStore.prototype as unknown as Record<WriteMethod, (...args: unknown[]) => IDBRequest>;
  const originals = Object.fromEntries(methods.map((m) => [m, proto[m]])) as Record<
    WriteMethod,
    (...args: unknown[]) => IDBRequest
  >;
  let aborted = 0;

  for (const method of methods) {
    const original = originals[method];
    proto[method] = function (this: IDBObjectStore, ...args: unknown[]) {
      const request = original.apply(this, args);
      const transaction = this.transaction;
      queueMicrotask(() => {
        const handler = request.onsuccess;
        request.onsuccess = function (this: IDBRequest, event: Event) {
          handler?.call(this, event);
          aborted += 1;
          transaction.abort();
        };
      });
      return request;
    };
  }

  return {
    aborted: () => aborted,
    restore: () => {
      for (const method of methods) proto[method] = originals[method];
    },
  };
}

/**
 * Promise が `ms` 以内に settle しなければ `did not settle` で reject する。abort を待たずに永遠に
 * settle しない、という壊れ方をテストのタイムアウトではなく、その場の失敗として読むため。
 */
export function settleWithin<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)),
  ]);
}
