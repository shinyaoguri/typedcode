/**
 * scripts/stryker-guard.mjs (変異検査の前に `.stryker-tmp` の有無を見る。#600) の検証。
 * 実行: `node --test scripts/stryker-guard.test.mjs` (CI は deploy.yml の check job が scripts/*.test.mjs を回す)。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { guardMessage, inspectStrykerTmp, STRYKER_TMP } from './stryker-guard.mjs';

const base = mkdtempSync(join(tmpdir(), 'stryker-guard-'));
after(() => rmSync(base, { recursive: true, force: true }));
const SCRIPT = fileURLToPath(new URL('./stryker-guard.mjs', import.meta.url));

/** テストごとに独立したパッケージディレクトリを作る。 */
function pkg(name, { tmp = false, backups = [] } = {}) {
  const dir = join(base, name);
  mkdirSync(dir);
  if (tmp) {
    mkdirSync(join(dir, STRYKER_TMP));
    for (const b of backups) mkdirSync(join(dir, STRYKER_TMP, b));
  }
  return dir;
}

describe('inspectStrykerTmp', () => {
  it('is clear when .stryker-tmp does not exist', () => {
    assert.deepEqual(inspectStrykerTmp(pkg('none')), { state: 'clear' });
  });

  it('is busy when .stryker-tmp exists without a backup directory', () => {
    const result = inspectStrykerTmp(pkg('empty', { tmp: true }));
    assert.equal(result.state, 'busy');
  });

  it('is leftover when .stryker-tmp holds a backup-* directory (sources may still be mutated)', () => {
    const result = inspectStrykerTmp(pkg('backup', { tmp: true, backups: ['backup-abc', 'sandbox-x'] }));
    assert.equal(result.state, 'leftover');
    assert.deepEqual(result.backups, ['backup-abc']);
  });
});

describe('guardMessage', () => {
  it('lets the run start when clear', () => {
    assert.equal(guardMessage({ state: 'clear' }), null);
  });

  it('points to the restore steps when a backup is left over', () => {
    const message = guardMessage(inspectStrykerTmp(pkg('msg-backup', { tmp: true, backups: ['backup-1'] })));
    assert.match(message ?? '', /backup-1/);
    assert.match(message ?? '', /途中で止まったとき/);
  });

  it('says the sources are untouched when there is no backup', () => {
    const message = guardMessage(inspectStrykerTmp(pkg('msg-busy', { tmp: true })));
    assert.match(message ?? '', /書き換えられていない/);
  });
});

describe('cli', () => {
  it('exits 0 when .stryker-tmp is absent', () => {
    const res = spawnSync(process.execPath, [SCRIPT, pkg('cli-clear')], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stderr);
  });

  it('exits non-zero before mutating when .stryker-tmp exists', () => {
    const res = spawnSync(process.execPath, [SCRIPT, pkg('cli-busy', { tmp: true, backups: ['backup-z'] })], {
      encoding: 'utf-8',
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /変異検査を始めません/);
  });
});
