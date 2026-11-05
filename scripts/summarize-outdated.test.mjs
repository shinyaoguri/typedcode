/**
 * scripts/summarize-outdated.mjs (npm 依存の古さの集計 / #261) の検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test scripts/summarize-outdated.test.mjs`
 * (`npm run check:fast` の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * fixture は `npm outdated --json` の実出力の形 (同名パッケージが複数 workspace にあると配列になる)。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  IGNORED,
  compareVersions,
  isBreaking,
  isSameReport,
  normalizeReport,
  parseVersion,
  summarizeOutdated,
} from './summarize-outdated.mjs';

const SCRIPT = fileURLToPath(new URL('./summarize-outdated.mjs', import.meta.url));

const info = (current, latest, dependent, wanted = current) => ({ current, wanted, latest, dependent });

/** 据え置きの仕組みを確かめるためのルール (既定の IGNORED は #208 の決着で空になったので、テストでは引数で渡す) */
const HOLD_TS7 = { name: 'typescript', from: '7.0.0', issue: '#208', reason: 'テスト用の据え置き' };

/** 実際の出力に近い fixture: 0.x の minor・据え置き・stub 型の逆転・root の dev 依存・patch を 1 つずつ含む。 */
const FIXTURE = {
  '@wasmer/sdk': info('0.10.0', '0.19.1', 'editor'),
  typescript: [info('6.0.3', '7.0.2', 'editor'), info('6.0.3', '7.0.2', 'verify')],
  '@types/jszip': info('3.4.1', '3.4.0', 'editor'),
  '@biomejs/biome': info('2.6.3', '2.6.4', 'typedcode', '2.6.4'),
  marked: info('18.1.1', '18.1.3', 'editor', '18.1.3'),
};

describe('isBreaking', () => {
  it('counts 0.10.0 → 0.19.1 as breaking (a 0.x minor bump)', () => {
    assert.equal(isBreaking('0.10.0', '0.19.1'), true);
  });

  it('counts a major bump as breaking', () => {
    assert.equal(isBreaking('6.0.3', '7.0.2'), true);
  });

  it('does not count a minor or patch bump of a 1.x+ package', () => {
    assert.equal(isBreaking('18.1.1', '18.2.0'), false);
    assert.equal(isBreaking('18.1.1', '18.1.3'), false);
  });

  it('does not count a patch bump of a 0.x package, but counts one of a 0.0.x package', () => {
    assert.equal(isBreaking('0.19.1', '0.19.4'), false);
    assert.equal(isBreaking('0.0.3', '0.0.4'), true);
  });

  it('does not count a downgrade or an unreadable version', () => {
    assert.equal(isBreaking('8.0.0', '7.0.2'), false);
    assert.equal(isBreaking('0.19.1', '0.10.0'), false);
    assert.equal(isBreaking('-', '1.0.0'), false);
  });
});

describe('parseVersion / compareVersions', () => {
  it('reads a plain, v-prefixed or prerelease version', () => {
    assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseVersion('v1.2.3-beta.1'), [1, 2, 3]);
    assert.equal(parseVersion('-'), null);
  });

  it('compares numerically, not as strings (0.9.0 < 0.19.0)', () => {
    assert.ok(compareVersions('0.9.0', '0.19.0') < 0);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('x', '1.0.0'), null);
  });
});

describe('summarizeOutdated (fixture)', () => {
  const result = summarizeOutdated(FIXTURE, [HOLD_TS7]);

  it('lists @wasmer/sdk 0.10.0 → 0.19.1 in the breaking table (a)', () => {
    const breaking = result.markdown.split('据え置き中')[0];
    assert.match(breaking, /\| `@wasmer\/sdk` \| 0\.10\.0 \| 0\.19\.1 \| editor \|/);
  });

  it('moves typescript >=7 out of the main table into a held-back section with its reason (b)', () => {
    const [main, held] = result.markdown.split('据え置き中');
    assert.doesNotMatch(main.split('<details>')[0], /typescript/);
    assert.doesNotMatch(main, /\| `typescript` \|/);
    assert.match(held, /\| `typescript` \| 6\.0\.3 \| 7\.0\.2 \| editor, verify \|.*#208/);
    assert.equal(result.ignored, 2);
  });

  it('does not count rows whose latest is older than current (c)', () => {
    assert.doesNotMatch(result.markdown, /@types\/jszip/);
  });

  it('keeps a root devDependency row (d)', () => {
    assert.match(result.markdown, /\| `@biomejs\/biome` \| 2\.6\.3 \| 2\.6\.4 \| 2\.6\.4 \| typedcode \|/);
  });

  it('counts only the main-table rows: wasmer, biome and marked (3), of which only wasmer is breaking', () => {
    assert.equal(result.count, 3);
    assert.equal(result.breaking, 1);
    assert.match(result.markdown, /古い依存: \*\*3 件\*\* \(うち breaking の可能性あり: \*\*1 件\*\*\)/);
  });
});

describe('summarizeOutdated (boundaries)', () => {
  it('returns an empty report when nothing is outdated', () => {
    assert.deepEqual(summarizeOutdated({}), { count: 0, breaking: 0, ignored: 0, markdown: '' });
  });

  it('returns an empty report (no issue comment) when only held-back rows remain', () => {
    const result = summarizeOutdated({ typescript: info('6.0.3', '7.0.2', 'editor') }, [HOLD_TS7]);
    assert.equal(result.count, 0);
    assert.equal(result.markdown, '');
    assert.equal(result.ignored, 1);
  });

  it('does not hold back typescript while the latest is still below the ignored range', () => {
    const result = summarizeOutdated({ typescript: info('6.0.2', '6.0.3', 'editor') }, [HOLD_TS7]);
    assert.equal(result.count, 1);
    assert.equal(result.ignored, 0);
  });

  it('takes the ignore list as an argument', () => {
    const rule = { name: 'marked', from: '18.0.0', issue: '#1', reason: 'テスト' };
    const result = summarizeOutdated({ marked: info('18.1.1', '18.1.3', 'editor') }, [rule]);
    assert.equal(result.count, 0);
    assert.equal(result.ignored, 1);
  });

  it('ships an empty default ignore list, so typescript >=7 is reported again after #208', () => {
    assert.deepEqual(IGNORED, []);
    const result = summarizeOutdated({ typescript: info('7.0.2', '7.1.0', 'editor') });
    assert.equal(result.count, 1);
    assert.equal(result.ignored, 0);
    assert.match(result.markdown, /\| `typescript` \| 7\.0\.2 \|/);
  });
});

describe('isSameReport', () => {
  const report = (run, sha, deps) => `## 鮮度チェック結果 (Freshness)

- 実行: [\`${run}\`](https://example.invalid/runs/${run})
- 対象コミット: \`${sha}\`

### 2. npm 依存の古さ

${deps}
`;

  it('is the same when only the run id and the target commit differ', () => {
    assert.equal(isSameReport(report('1', 'aaa', '古い依存: 3 件'), report('2', 'bbb', '古い依存: 3 件')), true);
  });

  it('differs when the findings differ', () => {
    assert.equal(isSameReport(report('1', 'aaa', '古い依存: 3 件'), report('2', 'bbb', '古い依存: 4 件')), false);
  });

  it('ignores CRLF and trailing whitespace', () => {
    assert.equal(isSameReport('a  \r\nb\r\n', 'a\nb'), true);
  });

  it('strips only the two header lines', () => {
    const normalized = normalizeReport(report('1', 'aaa', '古い依存: 3 件'));
    assert.doesNotMatch(normalized, /実行|対象コミット/);
    assert.match(normalized, /古い依存: 3 件/);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summarize-outdated-'));
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '', ...env },
    });

  it('writes the summary and the count to GITHUB_OUTPUT', () => {
    const input = join(dir, 'outdated.json');
    const body = join(dir, 'deps.md');
    const out = join(dir, 'output');
    writeFileSync(input, JSON.stringify(FIXTURE));
    writeFileSync(out, '');
    const result = run(['--input', input, '--body-file', body], { GITHUB_OUTPUT: out });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(body, 'utf8'), /@wasmer\/sdk/);
    // CLI は既定の IGNORED (空) を使うので、fixture の typescript 7 も数える。件数は workspace ごとの行の数
    // (wasmer・typescript × 2 (editor / verify)・biome・marked)
    assert.equal(readFileSync(out, 'utf8'), 'count=5\n');
  });

  it('treats an empty npm outdated output as 0 findings', () => {
    const input = join(dir, 'empty.json');
    const body = join(dir, 'empty.md');
    writeFileSync(input, '');
    assert.equal(run(['--input', input, '--body-file', body]).status, 0);
    assert.equal(readFileSync(body, 'utf8'), '');
  });

  it('exits 2 when the input is not JSON', () => {
    const input = join(dir, 'broken.json');
    writeFileSync(input, 'not json');
    assert.equal(run(['--input', input, '--body-file', join(dir, 'x.md')]).status, 2);
  });

  it('--same-report exits 0 for the same report and 1 for a changed one', () => {
    const a = join(dir, 'a.md');
    const b = join(dir, 'b.md');
    const c = join(dir, 'c.md');
    writeFileSync(a, '- 実行: 1\n- 対象コミット: `x`\n\n古い依存: 3 件\n');
    writeFileSync(b, '- 実行: 2\n- 対象コミット: `y`\n\n古い依存: 3 件\n');
    writeFileSync(c, '- 実行: 3\n- 対象コミット: `z`\n\n古い依存: 4 件\n');
    assert.equal(run(['--same-report', a, b]).status, 0);
    assert.equal(run(['--same-report', a, c]).status, 1);
  });
});
