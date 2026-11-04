/**
 * 救出の出力 (#544 / #300 の受け入れ条件 8)。
 *
 * ZIP が作れなければ単一 JSON (全ソース + manifest)、それも保存できなければソースを 1 つずつ出す。
 * 救出は保存・排出待ち・署名の成功を前提にしないので、それらを呼ばない。
 * ZIP の生成とダウンロードは依存として差し替える (DOM も JSZip の失敗も node では起こせないため)。
 */

import { describe, it, expect, vi } from 'vitest';
import type { TabManager, TabState } from '../../ui/tabs/TabManager.js';
import { RESCUE_MANIFEST_PATH, type RescueFile, type RescueTabSource } from '../rescueBundle.js';
import { liveTabRescueSources, RescueExporter, type RescueExporterDeps, rescueTimestamp } from '../RescueExporter.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

/** 2026-11-04 09:05 (ローカル時刻) → RESCUE_TC2611040905 */
const NOW = new Date(2026, 10, 4, 9, 5);
const BASE = 'RESCUE_TC2611040905';

function source(id: string, content: string): RescueTabSource {
  return {
    id,
    filename: id,
    language: 'c',
    readContent: () => content,
    readEvents: () => [],
    persistedEventCount: 0,
    pendingEventCount: 0,
  };
}

interface Saved {
  filename: string;
  blob: Blob;
}

function setup(overrides: Partial<RescueExporterDeps> = {}) {
  const saved: Saved[] = [];
  const notices: string[] = [];
  const deps: RescueExporterDeps = {
    getSources: () => [source('a', 'int a;'), source('b', 'int b;')],
    getLastSave: () => null,
    mode: 'casual',
    now: () => NOW,
    buildZip: async (entries) => new Blob([JSON.stringify(entries)], { type: 'application/zip' }),
    download: (blob, filename) => saved.push({ blob, filename }),
    notify: (message) => notices.push(message),
    ...overrides,
  };
  return { exporter: new RescueExporter(deps), saved, notices };
}

describe('RescueExporter.rescueAll (#544)', () => {
  it('downloads RESCUE_TC<ts>.zip built from the sources and the manifest', async () => {
    const zipped: string[][] = [];
    const buildZip = async (entries: RescueFile[]) => {
      zipped.push(entries.map((e) => e.path));
      return new Blob(['zip']);
    };
    const { exporter, saved, notices } = setup({ buildZip });

    await expect(exporter.rescueAll()).resolves.toBe('zip');

    expect(zipped).toEqual([
      ['src/a.c', 'logs/a.c.events.json', 'src/b.c', 'logs/b.c.events.json', RESCUE_MANIFEST_PATH],
    ]);
    expect(saved.map((s) => s.filename)).toEqual([`${BASE}.zip`]);
    expect(notices).toEqual(['export.rescueSuccess']);
  });

  it('falls back to a single JSON file with every source and the manifest when building the ZIP throws', async () => {
    const { exporter, saved, notices } = setup({
      buildZip: async () => {
        throw new Error('zip failed');
      },
    });

    await expect(exporter.rescueAll()).resolves.toBe('json');

    expect(saved.map((s) => s.filename)).toEqual([`${BASE}.json`]);
    const json = JSON.parse(await saved[0]!.blob.text());
    expect(json.manifest).toMatchObject({ notAProof: true, schema: 'typedcode-rescue/2' });
    expect(
      json.files.filter((f: { path: string }) => f.path.startsWith('src/')).map((f: { content: string }) => f.content)
    ).toEqual(['int a;', 'int b;']);
    expect(notices).toEqual(['export.rescueJsonFallback']);
  });

  it('downloads each source separately when neither the ZIP nor the JSON can be saved', async () => {
    const saved: Saved[] = [];
    const { exporter, notices } = setup({
      buildZip: async () => {
        throw new Error('zip failed');
      },
      download: (blob, filename) => {
        if (filename.endsWith('.json')) throw new Error('json failed');
        saved.push({ blob, filename });
      },
    });

    await expect(exporter.rescueAll()).resolves.toBe('files');

    expect(saved.map((s) => s.filename)).toEqual([`${BASE}_a.c`, `${BASE}_b.c`]);
    expect(await Promise.all(saved.map((s) => s.blob.text()))).toEqual(['int a;', 'int b;']);
    expect(notices).toEqual(['export.rescueFailed']);
  });

  it('also downloads each preserved original content separately in the last resort (#413)', async () => {
    const saved: Saved[] = [];
    const { exporter } = setup({
      getSources: () => [
        { ...source('a', 'abc'), readUnprovenContents: () => [{ content: 'abcdef', chainContentLength: 3 }] },
      ],
      buildZip: async () => {
        throw new Error('zip failed');
      },
      download: (blob, filename) => {
        if (filename.endsWith('.json')) throw new Error('json failed');
        saved.push({ blob, filename });
      },
    });

    await exporter.rescueAll();

    expect(saved.map((s) => s.filename)).toEqual([`${BASE}_a.c`, `${BASE}_unproven_1_a.c`]);
    expect(await saved[1]!.blob.text()).toBe('abcdef');
  });

  it('reports failure without throwing when the tabs cannot be read at all', async () => {
    const { exporter, saved, notices } = setup({
      getSources: () => {
        throw new Error('tab manager broken');
      },
    });

    await expect(exporter.rescueAll()).resolves.toBe('failed');
    expect(saved).toEqual([]);
    expect(notices).toEqual(['export.rescueFailed']);
  });
});

describe('liveTabRescueSources (#544)', () => {
  /** 救出が呼んではいけない待機・保存の口をすべて spy にしたタブと TabManager */
  function liveTabs() {
    const waitForQueueDrain = vi.fn();
    const waitForFlush = vi.fn();
    const flushToIndexedDB = vi.fn();
    const tab = {
      id: 'tab-1',
      filename: 'main',
      language: 'c',
      model: { getValue: () => 'int main(void) {}' },
      typingProof: {
        serializeState: () => ({ events: [{ sequence: 0 }, { sequence: 1 }] }),
        getPendingEvents: () => [{}, {}, {}],
        waitForQueueDrain,
      },
      signedCheckpointService: { waitForFlush },
      unprovenContents: [{ content: 'int main(void) { pending }', chainContentLength: 17 }],
    } as unknown as TabState;
    const tabManager = {
      getAllTabs: () => [tab],
      getPersistenceReport: () => ({ persistedEventCounts: new Map([['tab-1', 1]]), lastSave: null }),
      flushToIndexedDB,
    } as unknown as Pick<TabManager, 'getAllTabs' | 'getPersistenceReport'>;
    return { tabManager, waitForQueueDrain, waitForFlush, flushToIndexedDB };
  }

  it('reads content, chain events and counts from the live tab', () => {
    const [rescued] = liveTabRescueSources(liveTabs().tabManager);

    expect(rescued?.readContent()).toBe('int main(void) {}');
    expect(rescued?.readEvents()).toHaveLength(2);
    expect(rescued).toMatchObject({ persistedEventCount: 1, pendingEventCount: 3 });
  });

  it('reads the preserved original contents from the tab in memory (#413)', () => {
    const [rescued] = liveTabRescueSources(liveTabs().tabManager);

    expect(rescued?.readUnprovenContents?.()).toEqual([
      { content: 'int main(void) { pending }', chainContentLength: 17 },
    ]);
  });

  it('never waits for the PoSW queue, the IndexedDB flush or checkpoint signing', async () => {
    const live = liveTabs();
    const { exporter } = setup({ getSources: () => liveTabRescueSources(live.tabManager) });

    await exporter.rescueAll();

    expect(live.waitForQueueDrain).not.toHaveBeenCalled();
    expect(live.flushToIndexedDB).not.toHaveBeenCalled();
    expect(live.waitForFlush).not.toHaveBeenCalled();
  });
});

describe('rescueTimestamp (#544)', () => {
  it('formats the local time as YYMMDDHHmm like the normal export', () => {
    expect(rescueTimestamp(NOW)).toBe('2611040905');
  });
});
