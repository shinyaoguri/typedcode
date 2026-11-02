// @vitest-environment happy-dom
/**
 * 状態契約のうち DOM の 1 要素に閉じないもの (`html[data-app-state]` と dev フック `__tcTestSnapshot` の中身) のテスト (#433)。
 * E2E の `expectConsistent()` は snapshot と DOM の data-* を突き合わせるので、snapshot 側の表現
 * (表示順・拡張子込みの filename・タブ 0 本の表し方) をここで固定する。
 */

import { describe, expect, it } from 'vitest';
import { buildTestSnapshot, getAppState, setAppState, type SnapshotSource } from '../stateContract.js';

interface FakeTabInput {
  id: string;
  filename: string;
  language: string;
  content: string;
  totalEvents: number;
  pendingCount: number;
  currentHash: string | null;
}

function source(tabs: FakeTabInput[], activeId: string | null): SnapshotSource {
  const built = tabs.map((t) => ({
    id: t.id,
    filename: t.filename,
    language: t.language,
    model: { getValue: () => t.content },
    typingProof: {
      getStats: () => ({
        totalEvents: t.totalEvents,
        pendingCount: t.pendingCount,
        currentHash: t.currentHash,
        duration: 0,
        eventTypes: {},
      }),
    },
  }));
  return {
    getAllTabs: () => built as unknown as ReturnType<SnapshotSource['getAllTabs']>,
    getActiveTab: () => built.find((t) => t.id === activeId) ?? null,
  };
}

describe('buildTestSnapshot', () => {
  it('lists tabs in display order with the full filename, content and proof stats', () => {
    const snapshot = buildTestSnapshot(
      source(
        [
          {
            id: 'b',
            filename: 'second',
            language: 'python',
            content: 'x = 1',
            totalEvents: 5,
            pendingCount: 1,
            currentHash: 'h2',
          },
          {
            id: 'a',
            filename: 'first',
            language: 'c',
            content: '',
            totalEvents: 1,
            pendingCount: 0,
            currentHash: null,
          },
        ],
        'a'
      ),
      'ready'
    );

    expect(snapshot).toEqual({
      appState: 'ready',
      activeTabId: 'a',
      tabs: [
        {
          id: 'b',
          filename: 'second.py',
          language: 'python',
          content: 'x = 1',
          totalEvents: 5,
          pendingCount: 1,
          currentHash: 'h2',
        },
        {
          id: 'a',
          filename: 'first.c',
          language: 'c',
          content: '',
          totalEvents: 1,
          pendingCount: 0,
          currentHash: null,
        },
      ],
    });
  });

  it('reports no active tab and no tabs before the tab manager exists', () => {
    expect(buildTestSnapshot(null, 'initializing')).toEqual({ appState: 'initializing', activeTabId: null, tabs: [] });
  });
});

describe('app state attribute', () => {
  it('round-trips the app state through html[data-app-state]', () => {
    setAppState('gate');

    expect(document.documentElement.getAttribute('data-app-state')).toBe('gate');
    expect(getAppState()).toBe('gate');
  });
});
