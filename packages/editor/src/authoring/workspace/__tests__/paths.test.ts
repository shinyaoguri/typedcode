import { describe, expect, it } from 'vitest';
import { problemIdFromPath, resolveWorkspaceReference, workspaceBasename } from '../paths.js';

describe('resolveWorkspaceReference', () => {
  it('resolves a reference relative to the directory of the definition file', () => {
    expect(resolveWorkspaceReference('過去問/探索.problem.yaml', '探索.md')).toEqual({
      ok: true,
      path: '過去問/探索.md',
    });
  });

  it('allows .. that stays inside the opened folder', () => {
    expect(resolveWorkspaceReference('過去問/x.problem.yaml', '../共通.md')).toEqual({ ok: true, path: '共通.md' });
  });

  it('rejects .. that climbs out of the opened folder', () => {
    expect(resolveWorkspaceReference('最大値.problem.yaml', '../外.md')).toEqual({ ok: false, reason: 'outside-root' });
  });

  it('rejects .. that climbs out after first descending into a subfolder', () => {
    expect(resolveWorkspaceReference('a/x.problem.yaml', 'b/../../../外.md')).toEqual({
      ok: false,
      reason: 'outside-root',
    });
  });

  it('rejects an absolute POSIX path', () => {
    expect(resolveWorkspaceReference('最大値.problem.yaml', '/abs.md')).toEqual({ ok: false, reason: 'absolute' });
  });

  it('rejects a path with a drive letter', () => {
    expect(resolveWorkspaceReference('最大値.problem.yaml', 'C:/abs.md')).toEqual({ ok: false, reason: 'absolute' });
  });

  it('rejects backslash separators', () => {
    expect(resolveWorkspaceReference('最大値.problem.yaml', 'sub\\a.md')).toEqual({ ok: false, reason: 'backslash' });
  });

  it('rejects a reference that resolves to the folder itself rather than a file', () => {
    expect(resolveWorkspaceReference('a/x.problem.yaml', '..')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a blank reference', () => {
    expect(resolveWorkspaceReference('x.problem.yaml', '  ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('workspaceBasename / problemIdFromPath', () => {
  it('takes the last path segment as the basename', () => {
    expect(workspaceBasename('過去問/探索-初期.c')).toBe('探索-初期.c');
  });

  it('derives the problem id from the file name stem without .problem.yaml', () => {
    expect(problemIdFromPath('過去問/探索.problem.yaml')).toBe('探索');
  });

  it('falls back to dropping the last extension when the name lacks .problem.yaml', () => {
    expect(problemIdFromPath('a/b.yaml')).toBe('b');
  });
});
