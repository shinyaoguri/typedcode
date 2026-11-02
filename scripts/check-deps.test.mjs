/**
 * scripts/check-deps.mjs (README の依存表と package.json の突合 / #269) の検証。
 *
 * 実行: `node --test scripts/check-deps.test.mjs`
 * (`npm run check:fast` と check job の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * 純関数 (表の読み取り・比較) と、一時ディレクトリに組んだ fixture への checkRepo を検証する。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkRepo, compareDependencies, parseDependencyTable } from './check-deps.mjs';

const TABLE = [
  '## 依存関係',
  '',
  '| パッケージ | 用途 |',
  '|---------|---------|',
  '| `alpha` | A |',
  '| beta | B |',
  '',
  '次の節',
].join('\n');

describe('parseDependencyTable', () => {
  it('returns the first-column names of the dependency table and stops at the end of the table', () => {
    assert.deepEqual(parseDependencyTable(TABLE), ['alpha', 'beta']);
  });

  it('returns null when the README has no dependency table', () => {
    assert.equal(parseDependencyTable('# title\n\n| 名前 | 値 |\n|---|---|\n| a | b |\n'), null);
  });
});

describe('compareDependencies', () => {
  it('reports a runtime dependency that is missing from the table', () => {
    const result = compareDependencies({ tableNames: ['alpha'], dependencies: { alpha: '^1', beta: '^2' } });
    assert.deepEqual(result.missingFromTable, ['beta']);
    assert.deepEqual(result.notInPackageJson, []);
  });

  it('reports a table row that is in neither dependencies nor devDependencies', () => {
    const result = compareDependencies({
      tableNames: ['alpha', 'ghost'],
      dependencies: { alpha: '^1' },
      devDependencies: {},
    });
    assert.deepEqual(result.missingFromTable, []);
    assert.deepEqual(result.notInPackageJson, ['ghost']);
  });

  it('accepts a devDependency in the table but does not require it', () => {
    const withDev = compareDependencies({
      tableNames: ['alpha', 'vite'],
      dependencies: { alpha: '^1' },
      devDependencies: { vite: '^8' },
    });
    const withoutDev = compareDependencies({
      tableNames: ['alpha'],
      dependencies: { alpha: '^1' },
      devDependencies: { vite: '^8' },
    });
    for (const result of [withDev, withoutDev]) {
      assert.deepEqual(result, { missingFromTable: [], notInPackageJson: [] });
    }
  });
});

describe('checkRepo (fixture)', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  function pkg(name, readme, packageJson) {
    const dir = join(root, 'packages', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), readme);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
  }

  pkg('ok', TABLE, { dependencies: { alpha: '^1', beta: '^2' } });
  pkg('no-table', '# no table\n', { dependencies: { alpha: '^1' } });
  pkg('missing', TABLE, { dependencies: { alpha: '^1', beta: '^2', gamma: '^3' } });
  pkg('stale', TABLE, { dependencies: { alpha: '^1' } });

  it('skips a package whose README has no dependency table', () => {
    const { checked } = checkRepo(root);
    assert.ok(!checked.includes('no-table'));
    assert.ok(checked.includes('ok'));
  });

  it('reports both directions with the package and the dependency name, and nothing for a matching package', () => {
    const { problems } = checkRepo(root);
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.includes('packages/missing/README.md') && p.includes('gamma')));
    assert.ok(problems.some((p) => p.includes('packages/stale/README.md') && p.includes('beta')));
    assert.ok(!problems.some((p) => p.includes('packages/ok/')));
  });
});
