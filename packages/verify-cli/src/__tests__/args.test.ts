import { describe, it, expect } from 'vitest';
import { findFlagError, flagValue, flagValues, nonFlagArgs } from '../args.js';

/**
 * #148: 未知フラグ・タイポの黙殺はセキュリティゲートのサイレント無効化になる。
 * ホワイトリスト検証の挙動を固定する。
 */
describe('findFlagError', () => {
  it('accepts a known boolean gate flag', () => {
    expect(findFlagError(['proof.zip', '--require-root-anchor'])).toBeNull();
  });

  it('accepts value flags in both space and equals forms', () => {
    expect(findFlagError(['proof.zip', '--mode', 'fast'])).toBeNull();
    expect(findFlagError(['proof.zip', '--mode=fast'])).toBeNull();
    expect(findFlagError(['p.zip', '--analyzer', 'a.mjs', '--analyzer=b.mjs'])).toBeNull();
  });

  it('rejects a typo of a security gate flag instead of silently ignoring it', () => {
    expect(findFlagError(['proof.zip', '--require-root-anchr'])).toContain('Unknown option');
  });

  it('rejects an unknown short flag', () => {
    expect(findFlagError(['proof.zip', '-x'])).toContain('Unknown option');
  });

  it('rejects equals form on a boolean flag instead of silently ignoring it', () => {
    expect(findFlagError(['proof.zip', '--require-anchor-density=true'])).toContain(
      'does not take a value'
    );
  });

  it('rejects a value flag with a missing value', () => {
    expect(findFlagError(['proof.zip', '--mode'])).toContain('requires a value');
    expect(findFlagError(['proof.zip', '--mode', '--require-root-anchor'])).toContain(
      'requires a value'
    );
  });
});

describe('flagValue / flagValues', () => {
  it('reads a value in both forms', () => {
    expect(flagValue(['--mode', 'fast'], '--mode')).toBe('fast');
    expect(flagValue(['--mode=audit'], '--mode')).toBe('audit');
    expect(flagValue([], '--mode')).toBeUndefined();
  });

  it('collects repeated values across both forms', () => {
    expect(flagValues(['--analyzer', 'a.mjs', '--analyzer=b.mjs'], '--analyzer')).toEqual([
      'a.mjs',
      'b.mjs',
    ]);
  });
});

describe('nonFlagArgs', () => {
  it('keeps positionals and skips flags together with their values', () => {
    expect(
      nonFlagArgs(['proof.zip', '--mode', 'fast', '--require-root-anchor', '--analysis-json=o.json'])
    ).toEqual(['proof.zip']);
  });
});
