/**
 * 二重インスタンスの解消 (#237 PR-3)。
 *
 * fallback 経路 (Web Locks を使えず ping → pong) の再現: 凍結中の A を後発の B がすり抜け、同じセッションを
 * resumeSession する。凍結を解かれた A と B は互いの heartbeat を受け取る (ガードの重複検出)。
 * sessions 行の instanceId が自分でない側 (= 後から復帰した A) だけが譲って読み取り専用になり、B の記録は続く。
 * 両方が譲る・両方が譲らない、のどちらも起きないことをここで固定する。
 *
 * 2 つの SessionStorageService を fake-indexeddb の同じ DB に開いて 2 インスタンスを表す。ガードは
 * コールバックを受け取るだけの最小の偽物 (heartbeat の受信は SingleInstanceGuard.test.ts で見ている)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { StoredEvent, StoredTabData } from '@typedcode/shared';
import { setStorageNamespace } from '../../core/storageKeys.js';
import { SessionOwnershipError, SessionStorageService } from '../SessionStorageService.js';
import {
  enterInstanceConflictReadOnly,
  type InstanceConflictReadOnlyTargets,
  startInstanceConflictMonitor,
} from '../InstanceConflictMonitor.js';

function makeEvent(sequence: number, hash: string): StoredEvent {
  return {
    sequence,
    timestamp: sequence * 10,
    type: 'contentChange',
    inputType: 'insertText',
    data: `char-${sequence}`,
    rangeOffset: sequence,
    rangeLength: 0,
    range: null,
    previousHash: null,
    posw: { iterations: 1, nonce: `nonce-${sequence}`, intermediateHash: `mid-${sequence}`, computeTimeMs: 1 },
    hash,
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
  };
}

function makeTab(id: string, sessionId: string): StoredTabData {
  return {
    id,
    sessionId,
    filename: `${id}.ts`,
    language: 'typescript',
    content: '',
    createdAt: 1000,
    lastModifiedAt: 1000,
    lastWrittenEventIndex: -1,
    currentHash: null,
    startTime: 1000,
    verificationState: 'pending',
  };
}

/** ガードの偽物: 重複検出のコールバックを持つだけ。`heartbeatFrom` で相手の instance-active を受けたことにする */
class FakeGuard {
  private callback: ((senderId: string) => void) | null = null;
  setOnDuplicateDetected(callback: ((senderId: string) => void) | null): void {
    this.callback = callback;
  }
  heartbeatFrom(senderId: string): void {
    this.callback?.(senderId);
  }
}

/** document の偽物: resume / visibilitychange を投げられる EventTarget */
class FakeDocument extends EventTarget {
  visibilityState = 'visible';
}

interface Instance {
  storage: SessionStorageService;
  guard: FakeGuard;
  doc: FakeDocument;
  win: EventTarget;
  onYield: ReturnType<typeof vi.fn>;
  stop: () => void;
}

function monitor(storage: SessionStorageService): Instance {
  const guard = new FakeGuard();
  const doc = new FakeDocument();
  const win = new EventTarget();
  const onYield = vi.fn();
  const stop = startInstanceConflictMonitor({
    guard,
    ownership: storage,
    documentTarget: doc as unknown as Document,
    windowTarget: win as unknown as Window,
    onYield,
  });
  return { storage, guard, doc, win, onYield, stop };
}

/** IndexedDB の確認が終わるまで待つ (fake-indexeddb は setImmediate で進む) */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('InstanceConflictMonitor on the ping/pong fallback (#237)', () => {
  const opened: SessionStorageService[] = [];

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const service of opened.splice(0)) service.close();
    vi.restoreAllMocks();
  });

  /** A が記録中に凍結され、すり抜けた B が同じセッションを再開した状態。A はまだ凍結を解かれていない */
  async function frozenAAndResumedB(): Promise<{ a: Instance; b: Instance; sessionId: string }> {
    const storageA = new SessionStorageService();
    opened.push(storageA);
    await storageA.initialize();
    const session = await storageA.createSession();
    await storageA.saveTab(makeTab('tab-1', session.sessionId));
    await storageA.appendEvent('tab-1', makeEvent(0, 'hash-0'));
    const a = monitor(storageA);

    const storageB = new SessionStorageService();
    opened.push(storageB);
    await storageB.initialize();
    await storageB.resumeSession(session.sessionId);
    const b = monitor(storageB);
    return { a, b, sessionId: session.sessionId };
  }

  it('makes only the instance whose session was resumed elsewhere yield when both see each other', async () => {
    const { a, b } = await frozenAAndResumedB();

    // 凍結を解かれた A と B が互いの heartbeat を何度か受け取る
    for (let i = 0; i < 3; i++) {
      a.guard.heartbeatFrom('instance-b');
      b.guard.heartbeatFrom('instance-a');
      await settle();
    }

    expect({ a: a.onYield.mock.calls.length, b: b.onYield.mock.calls.length }).toEqual({ a: 1, b: 0 });
  });

  it('keeps the recording of the instance that stays: its appends land and the yielded one cannot write over them', async () => {
    const { a, b } = await frozenAAndResumedB();
    a.guard.heartbeatFrom('instance-b');
    b.guard.heartbeatFrom('instance-a');
    await settle();

    await expect(b.storage.appendEvent('tab-1', makeEvent(1, 'hash-from-B'))).resolves.toBeUndefined();
    await expect(a.storage.appendEvent('tab-1', makeEvent(2, 'hash-from-A'))).rejects.toBeInstanceOf(
      SessionOwnershipError
    );

    expect((await b.storage.getEvents('tab-1')).map((e) => e.hash)).toEqual(['hash-0', 'hash-from-B']);
  });

  it('checks ownership on resume from a freeze before an event recorded at that moment is written', async () => {
    const { a, b } = await frozenAAndResumedB();

    // 凍結解除の瞬間: resume を受け、同じ同期区間で (visibility の記録などの) 書き込みが走る
    a.doc.dispatchEvent(new Event('resume'));
    const write = a.storage.appendEvent('tab-1', makeEvent(1, 'hash-from-A'));

    await expect(write).rejects.toBeInstanceOf(SessionOwnershipError);
    expect(a.onYield).toHaveBeenCalledTimes(1);
    expect((await b.storage.getEvents('tab-1')).map((e) => e.hash)).toEqual(['hash-0']);
  });

  it('checks ownership when the page becomes visible again, but not when it is hidden', async () => {
    const { a } = await frozenAAndResumedB();

    a.doc.visibilityState = 'hidden';
    a.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(a.onYield).not.toHaveBeenCalled();

    a.doc.visibilityState = 'visible';
    a.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(a.onYield).toHaveBeenCalledTimes(1);
  });

  it('checks ownership when the page is shown again (pageshow)', async () => {
    const { a } = await frozenAAndResumedB();

    a.win.dispatchEvent(new Event('pageshow'));
    await settle();

    expect(a.onYield).toHaveBeenCalledTimes(1);
  });

  it('never yields while it is the only instance that recorded the session', async () => {
    const storage = new SessionStorageService();
    opened.push(storage);
    await storage.initialize();
    await storage.createSession();
    const only = monitor(storage);

    only.doc.dispatchEvent(new Event('resume'));
    only.win.dispatchEvent(new Event('pageshow'));
    only.guard.heartbeatFrom('stale-heartbeat-from-a-closed-tab');
    await settle();

    expect(only.onYield).not.toHaveBeenCalled();
  });

  it('stops listening once stopped', async () => {
    const { a } = await frozenAAndResumedB();
    a.stop();

    a.guard.heartbeatFrom('instance-b');
    a.doc.dispatchEvent(new Event('resume'));
    await settle();

    expect(a.onYield).not.toHaveBeenCalled();
  });
});

describe('enterInstanceConflictReadOnly', () => {
  function targets(): InstanceConflictReadOnlyTargets & {
    signing: Array<{ dispose: ReturnType<typeof vi.fn> }>;
  } {
    const signing = [{ dispose: vi.fn() }, { dispose: vi.fn() }];
    return {
      signing,
      eventRecorder: { setEnabled: vi.fn() },
      tabManager: {
        suspendPersistence: vi.fn(),
        getAllTabs: () => [
          { signedCheckpointService: signing[0] },
          { signedCheckpointService: null },
          { signedCheckpointService: signing[1] },
        ],
      },
      screenshotTracker: { setCaptureEnabled: vi.fn() },
      guard: { dispose: vi.fn() },
      setEditorReadOnly: vi.fn(),
      showConflictScreen: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops recording, saving, signing, screenshots and the heartbeat, and shows the conflict screen', () => {
    const t = targets();

    enterInstanceConflictReadOnly(t);

    expect(t.eventRecorder?.setEnabled).toHaveBeenCalledWith(false);
    expect(t.tabManager?.suspendPersistence).toHaveBeenCalled();
    expect(t.signing.map((s) => s.dispose.mock.calls.length)).toEqual([1, 1]);
    expect(t.screenshotTracker?.setCaptureEnabled).toHaveBeenCalledWith(false);
    expect(t.guard.dispose).toHaveBeenCalled();
    expect(t.setEditorReadOnly).toHaveBeenCalled();
    expect(t.showConflictScreen).toHaveBeenCalled();
  });

  it('still shows the conflict screen when stopping something fails', () => {
    const t = targets();
    t.tabManager = {
      suspendPersistence: () => {
        throw new Error('boom');
      },
      getAllTabs: () => [],
    };

    enterInstanceConflictReadOnly(t);

    expect(t.showConflictScreen).toHaveBeenCalled();
  });
});
