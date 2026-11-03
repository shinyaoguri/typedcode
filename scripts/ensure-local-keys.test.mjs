/**
 * scripts/ensure-local-keys.mjs (dev 用の公開鍵置き場 localKeys.ts を .example から作る / #338) の検証。
 *
 * 実行: `node --test scripts/ensure-local-keys.test.mjs`
 * (`npm run check:fast` と check job の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * 実リポジトリは読むだけ (追跡されていない・ignore されている・.example が空・postinstall が呼ぶ)。
 * 「無ければ作る / あれば上書きしない」は一時ディレクトリを root に渡して確かめる。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ensureLocalKeys, LOCAL_KEYS_FILES } from './ensure-local-keys.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const [CHECKPOINT, EXAM] = LOCAL_KEYS_FILES;

function git(...args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** コメントを落とし、空白を詰めた本文 (例示の鍵はコメントの中にしか無いことを確かめる)。 */
function codeWithoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');
}

describe('the real repository', () => {
  it('does not track either localKeys.ts', () => {
    const result = git('ls-files', '--', ...LOCAL_KEYS_FILES);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  it('ignores both localKeys.ts through .gitignore', () => {
    for (const rel of LOCAL_KEYS_FILES) {
      // --no-index: 追跡されていても .gitignore の規則に当たるかだけを見る
      assert.equal(git('check-ignore', '-q', '--no-index', rel).status, 0, `${rel} が ignore されていない`);
    }
  });

  it('ships an example for each localKeys.ts whose key array is empty outside comments', () => {
    const expected = {
      [CHECKPOINT]: /LOCAL_CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey\[\] = \[ ?\] as const;/,
      [EXAM]: /LOCAL_EXAM_AUTHORITY_KEYS: readonly ExamAuthorityKey\[\] = \[ ?\] as const;/,
    };
    for (const rel of LOCAL_KEYS_FILES) {
      const code = codeWithoutComments(readFileSync(join(REPO_ROOT, `${rel}.example`), 'utf8'));
      assert.match(code, expected[rel], `${rel}.example の鍵配列が空でない`);
    }
  });

  it('runs this script from the root postinstall so npm install / npm ci creates the files', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts?.postinstall, 'node scripts/ensure-local-keys.mjs');
  });
});

describe('ensureLocalKeys', () => {
  let root;
  const quiet = () => {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'local-keys-'));
    for (const rel of LOCAL_KEYS_FILES) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, `${rel}.example`), `// example of ${rel}\nexport const KEYS = [];\n`);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates each missing file with the content of its example', () => {
    ensureLocalKeys({ root, log: quiet });

    for (const rel of LOCAL_KEYS_FILES) {
      assert.equal(readFileSync(join(root, rel), 'utf8'), readFileSync(join(root, `${rel}.example`), 'utf8'));
    }
  });

  it('never overwrites an existing file', () => {
    const devKeys = "export const KEYS = [{ keyId: 'tcp-dev-mine' }];\n";
    writeFileSync(join(root, CHECKPOINT), devKeys);

    ensureLocalKeys({ root, log: quiet });

    assert.equal(readFileSync(join(root, CHECKPOINT), 'utf8'), devKeys);
  });

  it('returns only the paths it created', () => {
    writeFileSync(join(root, CHECKPOINT), 'export const KEYS = [];\n');

    assert.deepEqual(ensureLocalKeys({ root, log: quiet }), [EXAM]);
    assert.deepEqual(ensureLocalKeys({ root, log: quiet }), []);
  });

  it('throws when the example is missing, so the CLI exits non-zero', () => {
    rmSync(join(root, `${EXAM}.example`));

    assert.throws(() => ensureLocalKeys({ root, log: quiet }), { code: 'ENOENT' });
  });
});
