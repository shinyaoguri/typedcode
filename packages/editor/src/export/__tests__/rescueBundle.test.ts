/**
 * 救出ファイルの組み立て (#544 / #300 の受け入れ条件 6・7)。
 *
 * 救出ファイルは証明ではない: `*_proof.json` を作らず、manifest に `notAProof: true` を書く。
 * 1 タブの読み出しが throw しても、他のタブのソースは出る。
 */

import { describe, it, expect } from 'vitest';
import { planExportFilenames } from '@typedcode/shared';
import {
  buildRescueBundle,
  RESCUE_MANIFEST_PATH,
  RESCUE_SCHEMA,
  rescueBundleEntries,
  type RescueTabSource,
} from '../rescueBundle.js';

function source(overrides: Partial<RescueTabSource> & { id: string }): RescueTabSource {
  return {
    filename: overrides.id,
    language: 'c',
    readContent: () => `// ${overrides.id}`,
    readEvents: () => [{ sequence: 0 }, { sequence: 1 }],
    persistedEventCount: 2,
    pendingEventCount: 0,
    ...overrides,
  };
}

const CREATED_AT = new Date('2026-11-04T00:00:00.000Z');

function build(sources: RescueTabSource[]) {
  return buildRescueBundle({ sources, mode: 'casual', createdAt: CREATED_AT, lastSave: null });
}

function fail(): never {
  throw new Error('boom');
}

describe('buildRescueBundle (#544)', () => {
  it('contains no *_proof.json among its entries', () => {
    const bundle = build([source({ id: 'a' }), source({ id: 'b' })]);

    expect(rescueBundleEntries(bundle).filter((f) => f.path.endsWith('_proof.json'))).toEqual([]);
  });

  it('marks the manifest as not a proof under the typedcode-rescue/1 schema', () => {
    const { manifest } = build([source({ id: 'a' })]);

    expect(manifest).toMatchObject({ schema: RESCUE_SCHEMA, notAProof: true, mode: 'casual' });
    expect(manifest.createdAt).toBe('2026-11-04T00:00:00.000Z');
  });

  it('records the chain, persisted and pending event counts of each tab', () => {
    const { manifest } = build([
      source({ id: 'a', readEvents: () => [1, 2, 3], persistedEventCount: 2, pendingEventCount: 4 }),
      source({ id: 'b', readEvents: () => [], persistedEventCount: null, pendingEventCount: null }),
    ]);

    expect(manifest.tabs.map((t) => [t.id, t.chainEventCount, t.persistedEventCount, t.pendingEventCount])).toEqual([
      ['a', 3, 2, 4],
      ['b', 0, null, null],
    ]);
  });

  it('writes each tab source under src/ and its chain events under logs/', () => {
    const bundle = build([source({ id: 'main', readContent: () => 'int main;', readEvents: () => [{ sequence: 0 }] })]);

    expect(bundle.files).toEqual([
      { path: 'src/main.c', content: 'int main;' },
      { path: 'logs/main.c.events.json', content: JSON.stringify([{ sequence: 0 }], null, 2) },
    ]);
    expect(bundle.manifest.tabs[0]).toMatchObject({ source: 'src/main.c', eventsLog: 'logs/main.c.events.json' });
  });

  it('still writes the other tabs sources when one tab content cannot be read', () => {
    const bundle = build([source({ id: 'a' }), source({ id: 'broken', readContent: fail }), source({ id: 'c' })]);

    expect(bundle.files.filter((f) => f.path.startsWith('src/')).map((f) => f.path)).toEqual(['src/a.c', 'src/c.c']);
    expect(bundle.manifest.tabs[1]).toMatchObject({ id: 'broken', source: null });
    expect(bundle.manifest.tabs[1]?.error).toMatch(/^content: Error: boom/);
  });

  it('still writes a tab source when only its events cannot be read', () => {
    const bundle = build([source({ id: 'a', readContent: () => 'kept', readEvents: fail })]);

    expect(bundle.files).toEqual([{ path: 'src/a.c', content: 'kept' }]);
    expect(bundle.manifest.tabs[0]).toMatchObject({ source: 'src/a.c', eventsLog: null, chainEventCount: null });
    expect(bundle.manifest.tabs[0]?.error).toMatch(/^events: Error: boom/);
  });

  it('names same-named tabs the way the normal export does', () => {
    const tabs = [
      source({ id: '1', filename: 'main', language: 'c' }),
      source({ id: '2', filename: 'main', language: 'c' }),
      source({ id: '3', filename: 'main.c', language: 'c' }),
    ];

    const bundle = build(tabs);

    expect(bundle.manifest.tabs.map((t) => t.source)).toEqual(
      planExportFilenames(tabs).map((names) => `src/${names.source}`)
    );
  });

  it('records the last save outcome with its error as a string', () => {
    const { manifest } = buildRescueBundle({
      sources: [],
      mode: 'exam',
      createdAt: CREATED_AT,
      lastSave: { idbOk: false, sessionStorageOk: true, error: new Error('Failed to append event') },
    });

    expect(manifest.lastSave).toEqual({
      idbOk: false,
      sessionStorageOk: true,
      error: 'Error: Failed to append event',
    });
  });

  it('adds the manifest to the entries as rescue-manifest.json', () => {
    const bundle = build([source({ id: 'a' })]);

    const manifestEntry = rescueBundleEntries(bundle).find((f) => f.path === RESCUE_MANIFEST_PATH);
    expect(JSON.parse(manifestEntry?.content ?? 'null')).toEqual(bundle.manifest);
  });
});
