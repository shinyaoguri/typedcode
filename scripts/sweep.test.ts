// scripts/sweep.sh の動作検証。
// 使い捨ての origin(bare リポジトリ)と clone を作り、実際に sweep を走らせて
// 「消すべきブランチを消し、消してはいけないブランチを残す」ことを確認する。
// CI 常設ではなくスクリプト変更時に手元で回す: npx vitest run scripts/sweep.test.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SWEEP = join(import.meta.dirname, 'sweep.sh');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sweep(cwd: string): string {
  return execFileSync('bash', [SWEEP], { cwd, encoding: 'utf8' });
}

function localBranches(cwd: string): string[] {
  return git(cwd, 'for-each-ref', 'refs/heads', '--format=%(refname:short)').split('\n');
}

describe('sweep.sh', () => {
  let dir: string;
  let clone: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    const origin = join(dir, 'origin.git');
    clone = join(dir, 'clone');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', origin]);
    execFileSync('git', ['clone', origin, clone]);
    git(clone, 'config', 'user.name', 'test');
    git(clone, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(clone, 'README.md'), 'hello\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'init');
    git(clone, 'push', '-u', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('upstream が消えたブランチを worktree ごと削除する', () => {
    git(clone, 'branch', 'feat/x');
    git(clone, 'push', '-u', 'origin', 'feat/x');
    const wt = join(dir, 'wt-x');
    git(clone, 'worktree', 'add', wt, 'feat/x');
    git(clone, 'push', 'origin', '--delete', 'feat/x');

    const out = sweep(clone);

    expect(out).toContain('removed: feat/x');
    expect(localBranches(clone)).not.toContain('feat/x');
    expect(existsSync(wt)).toBe(false);
  });

  it('upstream が残っているブランチは削除しない', () => {
    git(clone, 'branch', 'feat/y');
    git(clone, 'push', '-u', 'origin', 'feat/y');

    sweep(clone);

    expect(localBranches(clone)).toContain('feat/y');
  });

  // EnterWorktree のプレースホルダー掃除:
  // 「worktree-* という名前」「未 push」「main に完全に含まれる」の三条件が
  // そろったときだけ削除する。近傍例(名前が一致しない・固有コミットあり)は残す。
  it.each([
    { branch: 'worktree-old-session', ahead: false, removed: true },
    { branch: 'worktree-wip', ahead: true, removed: false },
    { branch: 'worktree', ahead: false, removed: false },
    { branch: 'my-worktree-old', ahead: false, removed: false },
    { branch: 'local-notes', ahead: false, removed: false },
  ])('未 push ブランチ $branch(固有コミット: $ahead)→ 削除: $removed', ({ branch, ahead, removed }) => {
    git(clone, 'branch', branch);
    if (ahead) {
      git(clone, 'checkout', branch);
      writeFileSync(join(clone, 'wip.txt'), 'wip\n');
      git(clone, 'add', '.');
      git(clone, 'commit', '-m', 'wip');
      git(clone, 'checkout', 'main');
    }

    sweep(clone);

    if (removed) {
      expect(localBranches(clone)).not.toContain(branch);
    } else {
      expect(localBranches(clone)).toContain(branch);
    }
  });

  it('プレースホルダーでも未コミットの変更がある worktree はスキップする', () => {
    git(clone, 'branch', 'worktree-dirty');
    const wt = join(dir, 'wt-dirty');
    git(clone, 'worktree', 'add', wt, 'worktree-dirty');
    writeFileSync(join(wt, 'uncommitted.txt'), 'dirty\n');

    const out = sweep(clone);

    expect(out).toContain('skip: worktree-dirty');
    expect(localBranches(clone)).toContain('worktree-dirty');
    expect(existsSync(wt)).toBe(true);
  });

  it('クリーンなプレースホルダーの worktree はブランチごと削除する', () => {
    git(clone, 'branch', 'worktree-clean');
    const wt = join(dir, 'wt-clean');
    git(clone, 'worktree', 'add', wt, 'worktree-clean');

    const out = sweep(clone);

    expect(out).toContain('removed: worktree-clean');
    expect(localBranches(clone)).not.toContain('worktree-clean');
    expect(existsSync(wt)).toBe(false);
  });
});
