import { afterEach, describe, expect, it } from 'vitest';
import { getI18n } from '../../../i18n/index.js';
import { type CopyResultOutcome, describeCopyResult } from '../copyResult.js';

/** 問題のコピーの結果 → 結果のダイアログの形 (#800) */
describe('describeCopyResult', () => {
  afterEach(() => getI18n().setLocale('ja'));

  it('reports a successful copy with the number of written files, the destination folder and the written paths', () => {
    const view = describeCopyResult({ status: 'copied', written: ['p.md', 'p.problem.yaml'] }, '共有');
    expect([view.message.includes('共有') && view.message.includes('2'), view.lists]).toEqual([
      true,
      [{ kind: 'written', label: expect.any(String), paths: ['p.md', 'p.problem.yaml'] }],
    ]);
  });

  it('reports a conflict as nothing written with every conflicting path', () => {
    const view = describeCopyResult({ status: 'conflict', paths: ['p.md', 'sub/p.c'] }, '共有');
    expect([view.status, view.message.includes('共有'), view.lists.map((list) => [list.kind, list.paths])]).toEqual([
      'conflict',
      true,
      [['conflict', ['p.md', 'sub/p.c']]],
    ]);
  });

  it('passes the source issues through for the issue list and lists no paths', () => {
    const issues = [{ kind: 'missing-file', problem: 'p.problem.yaml', path: 'p.md' } as const];
    const view = describeCopyResult({ status: 'source-invalid', issues }, '共有');
    expect([view.issues, view.lists]).toEqual([issues, []]);
  });

  it('reports a partial failure with the written paths, the failed path, its reason and the empty-file note', () => {
    const view = describeCopyResult(
      {
        status: 'failed',
        written: ['p.md'],
        failed: { status: 'failed', path: 'p.c', cause: new Error('disk full') },
      },
      '共有'
    );
    expect([
      view.message.includes('disk full'),
      view.lists.map((list) => [list.kind, list.paths]),
      view.note !== null,
    ]).toEqual([
      true,
      [
        ['written', ['p.md']],
        ['failed', ['p.c']],
      ],
      true,
    ]);
  });

  it('omits the written list when the copy failed before writing anything', () => {
    const view = describeCopyResult(
      { status: 'failed', written: [], failed: { status: 'failed', path: 'p.md', cause: new Error('denied') } },
      '共有'
    );
    expect(view.lists.map((list) => list.kind)).toEqual(['failed']);
  });

  it('lists the unsaved paths when the copy was stopped for unsaved edits', () => {
    const view = describeCopyResult({ status: 'dirty', paths: ['p.md'] }, '');
    expect(view.lists.map((list) => [list.kind, list.paths])).toEqual([['dirty', ['p.md']]]);
  });

  it('has a sentence for every result in both locales', () => {
    const outcomes: CopyResultOutcome[] = [
      { status: 'copied', written: ['a'] },
      { status: 'conflict', paths: ['a'] },
      { status: 'source-invalid', issues: [] },
      { status: 'failed', written: [], failed: { status: 'failed', path: 'a', cause: 'x' } },
      { status: 'dirty', paths: ['a'] },
      { status: 'same-folder' },
    ];
    for (const locale of ['ja', 'en'] as const) {
      getI18n().setLocale(locale);
      for (const outcome of outcomes) {
        const view = describeCopyResult(outcome, 'F');
        expect(view.message).not.toMatch(/^author\.|\$\{/);
        for (const list of view.lists) expect(list.label).not.toMatch(/^author\./);
      }
    }
  });
});
