import type { BrowserContext, Page, Route } from '@playwright/test';

/**
 * 障害注入のヘルパ (#435)。Workers の API・IndexedDB・画面共有のトラックに、ブラウザの外から
 * 失敗を入れる。判定は spec 側で状態契約と verify-cli の結論だけで読む (ここでは注入だけを持つ)。
 *
 * どの注入も「本当に効いたか」を spec で assert できるよう、呼ばれた回数を返す / window に残す。
 * 空振りした注入 (URL の取り違え・呼ばれる前に外れた) は、回数が 0 のまま緑になるので必ず見る。
 */

const WORKERS_PORT = Number(process.env.E2E_WORKERS_PORT ?? 8787);

/**
 * 注入できる Workers の API (`/api/<endpoint>`)。
 *
 * `**\/api/**` をまとめて塞がないこと: casual の export 前認証 (`/api/verify-captcha`) まで落ち、
 * export が設計どおり中止される (editor AGENTS.md の不変条件 6) ので、注入したい障害とは別の理由で
 * 失敗する。塞ぐ API は 1 つずつ選ぶ。
 */
export type WorkersEndpoint = 'session/start' | 'checkpoint/sign' | 'verify-captcha';

/**
 * 注入する障害の種類。
 * - `503`: CORS ヘッダ付きで 503 を返す (応答は届くが `response.ok` が偽 = HTTP エラーの経路)
 * - `abort`: 接続を切る (fetch が TypeError で reject する = ネットワークエラーの経路)
 * - `hang`: 応答しない (editor 側の fetch 上限 `WORKERS_FETCH_TIMEOUT_MS` = 10 秒で打ち切られる経路)
 */
export type ApiFault = '503' | 'abort' | 'hang';

export interface InjectedFault {
  /** route ハンドラが受けた本体のリクエスト数 (CORS の preflight `OPTIONS` は数えない)。 */
  calls(): number;
  /** 注入を外す (以降のリクエストは本物の Workers に届く)。 */
  remove(): Promise<void>;
}

/**
 * Workers の API 1 つに障害を入れる。`target` に BrowserContext を渡すと、そこで開く全ページに効く
 * (起動時のリクエストより先に効かせたいときは goto の前に呼ぶ)。
 */
export async function injectApiFault(
  target: Page | BrowserContext,
  endpoint: WorkersEndpoint,
  fault: ApiFault
): Promise<InjectedFault> {
  const url = `http://localhost:${WORKERS_PORT}/api/${endpoint}`;
  let calls = 0;
  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      // preflight は通す (落とすと 503 を返す前に CORS エラーになり、abort と区別できない)。
      await route.continue();
      return;
    }
    calls += 1;
    if (fault === '503') {
      await route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'injected 503' }),
      });
    } else if (fault === 'abort') {
      await route.abort('connectionfailed');
    }
    // hang: fulfill も continue もしない = 応答が返らない (workers-hang-export.spec.ts と同じ手口)。
  };
  await target.route(url, handler);
  return {
    calls: () => calls,
    remove: () => target.unroute(url, handler),
  };
}

/**
 * Cloudflare Turnstile のスクリプト (`challenges.cloudflare.com`) を読めなくする。
 * `hang` にすると Turnstile の読み込み待ちで起動が 30 秒を超えるので、abort だけを持つ。
 */
export async function blockTurnstileScript(target: Page | BrowserContext): Promise<InjectedFault> {
  const url = 'https://challenges.cloudflare.com/**';
  let calls = 0;
  const handler = async (route: Route) => {
    calls += 1;
    await route.abort('connectionfailed');
  };
  await target.route(url, handler);
  return {
    calls: () => calls,
    remove: () => target.unroute(url, handler),
  };
}

/** ページ内に残す注入の記録 (`window.__tcFaults`)。 */
interface PageFaultLog {
  /** 失敗させた `indexedDB.open` の回数 */
  idbOpenFailures: number;
  /** QuotaExceeded を投げた `add` / `put` / `setItem` の回数 */
  quotaFailures: number;
  /** `getDisplayMedia` が返した stream (新しい順ではなく取得順) */
  displayStreams: MediaStream[];
  /** `failStorageProbe` が失敗させた、試験用 DB への `put` の回数 (#626) */
  probeFailures?: number;
  /** `injectTransactionAbort` が abort させた transaction の数 (#543) */
  transactionAborts?: number;
  /** 保存先の注入で差し替える前の関数 (`restoreStorageFaults` が戻す。#543) */
  storageOriginals?: {
    add: IDBObjectStore['add'];
    put: IDBObjectStore['put'];
    setItem: Storage['setItem'];
  };
}

/**
 * `indexedDB.open` を失敗させる init script を入れる (#325 の再現)。名前が `typedcode-session` で
 * 始まる DB (各モードのセッション DB) だけを対象にし、ランディングの SessionDetector などが開く
 * 他の DB には触れない。
 *
 * 本物の open は呼ばず、偽の request を返して次のタスクで `onerror` を呼ぶ (`request.error` には
 * DOMException を入れる)。偽物は `IDBOpenDBRequest` の instanceof を満たさないが、editor の
 * `SessionStorageService.initialize` は `onerror` / `onsuccess` / `onupgradeneeded` しか見ない。
 * 呼ばれた回数は `idbOpenFailureCount` で読む。
 */
export async function failSessionDbOpen(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const w = window as unknown as { __tcFaults?: PageFaultLog };
    w.__tcFaults ??= { idbOpenFailures: 0, quotaFailures: 0, displayStreams: [] };
    const log = w.__tcFaults;
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function open(this: IDBFactory, name: string, version?: number) {
      if (!String(name).startsWith('typedcode-session')) {
        return originalOpen.call(this, name, version);
      }
      log.idbOpenFailures += 1;
      const request = new EventTarget() as EventTarget & Record<string, unknown>;
      Object.assign(request, {
        result: undefined,
        error: null,
        readyState: 'pending',
        source: null,
        transaction: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        onblocked: null,
      });
      setTimeout(() => {
        request.error = new DOMException('injected open failure', 'UnknownError');
        request.readyState = 'done';
        const event = new Event('error', { bubbles: false, cancelable: true });
        request.dispatchEvent(event);
        const onerror = request.onerror as ((ev: Event) => void) | null;
        onerror?.call(request, event);
      }, 0);
      return request as unknown as IDBOpenDBRequest;
    };
  });
}

/** `failSessionDbOpen` が失敗させた `indexedDB.open` の回数。 */
export function idbOpenFailureCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __tcFaults?: PageFaultLog }).__tcFaults?.idbOpenFailures ?? 0);
}

/** 起動時の空き容量の試験が書く DB の名前 (editor の `STORAGE_PROBE_DB_NAME`。#626) */
export const STORAGE_PROBE_DB_NAME = 'typedcode-storage-probe';

/**
 * 起動時の空き容量の試験 (#626) の書き込みの失敗の形。
 * - `quota`: put が同期で `QuotaExceededError` を投げる (ブラウザの割り当てを超えたとき)
 * - `ioError`: put の request は通り、その後に transaction が `DataError: Failed to write blobs (IOError)`
 *   で abort する。ディスクが本当に一杯のときに Chromium が返す形 (#626 の実ディスクでの再現。
 *   `QuotaExceededError` にはならない)
 */
export type StorageProbeFailure = 'quota' | 'ioError';

/**
 * 起動時の空き容量の試験 (#626) の書き込みを失敗させる init script を入れる。goto の前に呼ぶ。
 * 試験用 DB (`STORAGE_PROBE_DB_NAME`) の transaction での `put` だけを失敗させ、セッション DB の保存は
 * 通す (試験の後の起動と打鍵の保存は本物のまま)。失敗させた回数は `probeFailureCount` で読む。
 *
 * `ioError` は `injectTransactionAbort` と同じく request の success の後に abort する。本物の transaction の
 * `error` は読み取り専用の getter なので、その transaction にだけ同名のプロパティを定義して理由を持たせる
 * (abort の理由は editor の `settleOnCommit` が `transaction.error` から読む)。
 */
export async function failStorageProbe(
  target: Page | BrowserContext,
  failure: StorageProbeFailure = 'quota'
): Promise<void> {
  await target.addInitScript(
    ({ probeDbName, kind }) => {
      const w = window as unknown as { __tcFaults?: PageFaultLog };
      w.__tcFaults ??= { idbOpenFailures: 0, quotaFailures: 0, displayStreams: [] };
      const log = w.__tcFaults;
      log.probeFailures ??= 0;
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.transaction.db.name !== probeDbName) return originalPut.call(this, value, key);
        log.probeFailures = (log.probeFailures ?? 0) + 1;
        if (kind === 'quota') throw new DOMException('injected', 'QuotaExceededError');
        const request = originalPut.call(this, value, key);
        const transaction = this.transaction;
        Object.defineProperty(transaction, 'error', {
          value: new DOMException('Failed to write blobs (IOError)', 'DataError'),
          configurable: true,
        });
        request.addEventListener('success', () => transaction.abort());
        return request;
      };
    },
    { probeDbName: STORAGE_PROBE_DB_NAME, kind: failure }
  );
}

/** `failStorageProbe` が失敗させた回数 (= 試験が書き込みに来た回数)。 */
export function probeFailureCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __tcFaults?: PageFaultLog }).__tcFaults?.probeFailures ?? 0);
}

/**
 * 保存先の容量切れ (QuotaExceeded) を注入する (#300 の再現)。起動して `waitForSynced` を待った後に
 * 呼ぶ (起動前に入れると DB の作成から失敗して、保存失敗とは別の経路になる)。
 *
 * - `idb`: `IDBObjectStore.prototype.add` / `put` が `DOMException('injected', 'QuotaExceededError')` を投げる
 * - `idbAndSessionStorage`: 上に加えて `Storage.prototype.setItem` も投げる (sessionStorage への退避も全滅)
 *
 * 投げた回数は `quotaFailureCount` で読む。
 */
export async function injectQuotaExceeded(page: Page, scope: 'idb' | 'idbAndSessionStorage'): Promise<void> {
  await page.evaluate((s) => {
    const w = window as unknown as { __tcFaults?: PageFaultLog };
    w.__tcFaults ??= { idbOpenFailures: 0, quotaFailures: 0, displayStreams: [] };
    const log = w.__tcFaults;
    // 解除 (restoreStorageFaults) のために、最初の注入の前の関数を退避する
    log.storageOriginals ??= {
      add: IDBObjectStore.prototype.add,
      put: IDBObjectStore.prototype.put,
      setItem: Storage.prototype.setItem,
    };
    const fail = () => {
      log.quotaFailures += 1;
      throw new DOMException('injected', 'QuotaExceededError');
    };
    IDBObjectStore.prototype.add = function add() {
      return fail();
    };
    IDBObjectStore.prototype.put = function put() {
      return fail();
    };
    if (s === 'idbAndSessionStorage') {
      Storage.prototype.setItem = function setItem() {
        fail();
      };
    }
  }, scope);
}

/** `injectQuotaExceeded` が投げた回数 (`injectTransactionAbort` の `setItem` の失敗も数える)。 */
export function quotaFailureCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __tcFaults?: PageFaultLog }).__tcFaults?.quotaFailures ?? 0);
}

/**
 * request の success の後に transaction を abort させる (#543 / #300 の受け入れ条件 2)。起動して
 * `waitForSynced` を待った後に呼ぶ。容量切れなどで commit の時点で失敗する、の再現。
 *
 * - `idb`: `IDBObjectStore.prototype.put` の request が success した後に、その transaction を `abort()` する
 * - `idbAndSessionStorage`: 上に加えて `Storage.prototype.setItem` が QuotaExceeded を投げる
 *
 * 包むのは `put` だけ。保存の経路 (`appendEvent` の events の add → tabs 行の get → put、`saveTab`、
 * `updateSession`) はどれも put が transaction の最後の request なので、その後に abort すると待ちの
 * request が無く、`error` は来ずに `abort` だけが来る (commit 時の失敗と同じ形。`onabort` を待たない
 * 実装はここで永遠に settle しない)。`add` の後に abort すると、`appendEvent` が同じ transaction に足した
 * get が AbortError で失敗して `error` が bubble するので、`onabort` を待たない実装でも reject してしまい
 * 再現にならない。
 *
 * request の `onsuccess` は呼び出し側が request を受け取った直後に同期で設定するので、microtask で
 * それを包み直し、呼び出し側のハンドラを走らせてから abort する (先に abort すると、ハンドラが
 * 終わった transaction に触って throw し、別の壊れ方になる)。abort した回数は `transactionAbortCount` で読む。
 */
export async function injectTransactionAbort(page: Page, scope: 'idb' | 'idbAndSessionStorage'): Promise<void> {
  await page.evaluate((s) => {
    const w = window as unknown as { __tcFaults?: PageFaultLog };
    w.__tcFaults ??= { idbOpenFailures: 0, quotaFailures: 0, displayStreams: [] };
    const log = w.__tcFaults;
    log.storageOriginals ??= {
      add: IDBObjectStore.prototype.add,
      put: IDBObjectStore.prototype.put,
      setItem: Storage.prototype.setItem,
    };
    log.transactionAborts ??= 0;
    const originalPut = log.storageOriginals.put;
    IDBObjectStore.prototype.put = function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      const transaction = this.transaction;
      queueMicrotask(() => {
        const handler = request.onsuccess;
        request.onsuccess = function onsuccess(this: IDBRequest, event: Event) {
          handler?.call(this, event);
          log.transactionAborts = (log.transactionAborts ?? 0) + 1;
          transaction.abort();
        };
      });
      return request;
    };
    if (s === 'idbAndSessionStorage') {
      Storage.prototype.setItem = function setItem() {
        log.quotaFailures += 1;
        throw new DOMException('injected', 'QuotaExceededError');
      };
    }
  }, scope);
}

/** `injectTransactionAbort` が abort させた transaction の数。 */
export function transactionAbortCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __tcFaults?: PageFaultLog }).__tcFaults?.transactionAborts ?? 0);
}

/** `injectQuotaExceeded` / `injectTransactionAbort` の注入を外し、元の `add` / `put` / `setItem` に戻す。 */
export async function restoreStorageFaults(page: Page): Promise<void> {
  await page.evaluate(() => {
    const originals = (window as unknown as { __tcFaults?: PageFaultLog }).__tcFaults?.storageOriginals;
    if (!originals) throw new Error('no storage fault was injected');
    IDBObjectStore.prototype.add = originals.add;
    IDBObjectStore.prototype.put = originals.put;
    Storage.prototype.setItem = originals.setItem;
  });
}

/**
 * `getDisplayMedia` を包んで、返した stream を `window.__tcFaults.displayStreams` に退避する
 * init script を入れる。画面共有を始める前 (goto の前) に呼ぶ。
 */
export async function captureDisplayStreams(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const w = window as unknown as { __tcFaults?: PageFaultLog };
    w.__tcFaults ??= { idbOpenFailures: 0, quotaFailures: 0, displayStreams: [] };
    const log = w.__tcFaults;
    const original = MediaDevices.prototype.getDisplayMedia;
    MediaDevices.prototype.getDisplayMedia = async function getDisplayMedia(
      this: MediaDevices,
      options?: DisplayMediaStreamOptions
    ) {
      const stream = await original.call(this, options);
      log.displayStreams.push(stream);
      return stream;
    };
  });
}

/** `captureDisplayStreams` が退避した stream の数。 */
export function displayStreamCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __tcFaults?: PageFaultLog }).__tcFaults?.displayStreams.length ?? 0
  );
}

/**
 * 最後に取得した画面共有の video トラックに `ended` を投げる (ユーザーがブラウザの「共有を停止」を
 * 押したときと同じ通知)。`track.stop()` では `ended` が発火しない (仕様上、ページ自身が止めたときは
 * 出ない) ので、イベントを直接投げる。投げたトラックの数を返す。
 */
export function endLastScreenShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const streams = (window as unknown as { __tcFaults?: PageFaultLog }).__tcFaults?.displayStreams ?? [];
    const last = streams[streams.length - 1];
    if (!last) return 0;
    const tracks = last.getVideoTracks();
    for (const track of tracks) track.dispatchEvent(new Event('ended'));
    return tracks.length;
  });
}
