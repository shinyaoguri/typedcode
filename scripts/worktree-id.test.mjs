/**
 * scripts/worktree-id.mjs (dev サーバが名乗る作業ツリーの識別子。#552) の検証。
 * 実行: `node --test scripts/worktree-id.test.mjs` (CI は deploy.yml の check job が scripts/*.test.mjs を回す)。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REPO_ROOT, worktreeId, worktreeIdOf } from './worktree-id.mjs';

const base = mkdtempSync(join(tmpdir(), 'worktree-id-'));
after(() => rmSync(base, { recursive: true, force: true }));

describe('worktreeIdOf', () => {
  it('is 12 lowercase hex characters', () => {
    assert.match(worktreeIdOf('/repos/typedcode'), /^[0-9a-f]{12}$/);
  });

  it('differs between two worktrees', () => {
    const a = join(base, 'a');
    const b = join(base, 'b');
    mkdirSync(a);
    mkdirSync(b);
    assert.notEqual(worktreeIdOf(a), worktreeIdOf(b));
  });

  it('is the same through a symlink and with a trailing slash (realpath of the root)', () => {
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    assert.equal(worktreeIdOf(link), worktreeIdOf(real));
    assert.equal(worktreeIdOf(`${real}/`), worktreeIdOf(real));
  });

  it('normalizes a path that no longer exists (a pruned worktree in git worktree list)', () => {
    const gone = join(base, 'gone');
    assert.equal(worktreeIdOf(`${gone}/`), worktreeIdOf(gone));
  });
});

describe('worktreeId', () => {
  it('is the id of the repository root this file belongs to', () => {
    assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).name, 'typedcode');
    assert.equal(worktreeId(), worktreeIdOf(REPO_ROOT));
  });
});
