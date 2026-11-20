/**
 * 前のセッションを再開しないときの始め方 (#317)。
 *
 * 「新規」→「前のファイルを残す」(exam 以外の既定) は前のセッションのタブを閉じたタブにして残し、events と
 * スクリーンショットには触らない。「完全に削除する」(と exam) は従来どおり全ストアを消す。閉じたタブにできなければ
 * 新しいセッションを作らずに止まる (前のセッションは消えていない)。
 *
 * fake-indexeddb の本物の SessionStorageService を通す。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { StoredEvent, StoredScreenshotData, StoredTabData } from '@typedcode/shared';
import { setStorageNamespace } from '../../core/storageKeys.js';
import { SessionStorageService } from '../../services/SessionStorageService.js';
import { closedTabPolicyFor, shouldClearScreenshotsWhenAllTabsClosed } from '../closedTabs.js';
import { startNewSession } from '../sessionStart.js';

function makeTab(id: string, sessionId: string): StoredTabData {
  return {
    id,
    sessionId,
    filename: `${id}.c`,
    language: 'c',
    content: `int ${id};`,
    createdAt: 1000,
    lastModifiedAt: 1000,
    lastWrittenEventIndex: -1,
    currentHash: null,
    startTime: 1000,
    verificationState: 'pending',
  };
}

function makeEvent(sequence: number): StoredEvent {
  return {
    sequence,
    timestamp: sequence,
    type: 'contentChange',
    inputType: 'insertText',
    data: 'a',
    rangeOffset: 0,
    rangeLength: 0,
    range: null,
    previousHash: null,
    posw: { iterations: 1, nonce: 'n', intermediateHash: 'm', computeTimeMs: 1 },
    hash: `hash-${sequence}`,
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
  };
}

function screenshot(id: string, sessionId: string): StoredScreenshotData {
  return { id, sessionId, imageHash: 'h', timestamp: 1 } as unknown as StoredScreenshotData;
}

describe('startNewSession (#317)', () => {
  let service: SessionStorageService;
  let previous: string;

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    setStorageNamespace('casual');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service = new SessionStorageService();
    await service.initialize();
    previous = (await service.createSession()).sessionId;
    await service.saveTab(makeTab('a', previous));
    await service.appendEvent('a', makeEvent(0));
    await service.saveScreenshot(screenshot('shot-1', previous));
  });

  afterEach(() => {
    service.close();
    vi.restoreAllMocks();
  });

  it('keeps the previous tabs as closed tabs with their events and screenshots when keeping', async () => {
    const next = await startNewSession(service, previous, 'keep', () => 4242);

    expect(next.sessionId).not.toBe(previous);
    expect(service.getCurrentSessionId()).toBe(next.sessionId);
    expect(await service.getTab('a')).toMatchObject({ archived: true, archivedAt: 4242, content: 'int a;' });
    expect(await service.getEvents('a')).toHaveLength(1);
    expect(await service.getScreenshotCount(previous)).toBe(1);
    // 前のセッションの開いているタブとしては数えない (次の起動で復旧ダイアログが出ない)
    expect(await service.hasExistingSession()).toBe(false);
    expect((await service.listArchivedTabs()).map((t) => t.id)).toEqual(['a']);
  });

  it('removes everything of the previous session when deleting permanently', async () => {
    const next = await startNewSession(service, previous, 'delete');

    expect(service.getCurrentSessionId()).toBe(next.sessionId);
    expect(await service.getTab('a')).toBeNull();
    expect(await service.getEvents('a')).toEqual([]);
    expect(await service.getScreenshotCount()).toBe(0);
  });

  it('does not create a new session when the previous tabs cannot be kept', async () => {
    vi.spyOn(service, 'archiveSessionTabs').mockRejectedValueOnce(new Error('quota'));

    await expect(startNewSession(service, previous, 'keep')).rejects.toThrow('quota');

    expect(service.getCurrentSessionId()).toBe(previous);
    expect((await service.getTab('a'))?.archived).toBeUndefined();
    expect(await service.getEvents('a')).toHaveLength(1);
  });
});

describe('closed tab handling by mode (#317)', () => {
  it.each([
    ['casual', 'archive', false],
    ['class', 'archive', false],
    ['assignment', 'archive', false],
    ['exam', 'delete', true],
  ] as const)('%s keeps closed tabs as %s and clears screenshots on the last close: %s', (mode, policy, clear) => {
    expect(closedTabPolicyFor(mode)).toBe(policy);
    expect(shouldClearScreenshotsWhenAllTabsClosed(mode)).toBe(clear);
  });
});
