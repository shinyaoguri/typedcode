/**
 * scripts/app-version.mjs (About に出す版をタグ名から決める。#842 / ADR-0055) の検証。
 * 実行: `node --test scripts/app-version.test.mjs` (CI は check job が scripts/*.test.mjs を回す)。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveAppVersion } from './app-version.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveAppVersion', () => {
  it('strips the v prefix from a beta tag name', () => {
    assert.equal(resolveAppVersion({ version: 'v2027.2.0-beta.3', commit: 'abc1234' }), '2027.2.0-beta.3');
  });

  it('strips the v prefix from a release tag name', () => {
    assert.equal(resolveAppVersion({ version: 'v1.5.0', commit: 'abc1234' }), '1.5.0');
  });

  it('accepts a version without the v prefix as is', () => {
    assert.equal(resolveAppVersion({ version: '2027.2.0', commit: 'abc1234' }), '2027.2.0');
  });

  it('falls back to dev+<commit> when no version is given', () => {
    assert.equal(resolveAppVersion({ commit: 'abc1234' }), 'dev+abc1234');
  });

  it('treats an empty or blank version as not given', () => {
    assert.equal(resolveAppVersion({ version: '', commit: 'abc1234' }), 'dev+abc1234');
    assert.equal(resolveAppVersion({ version: '  ', commit: 'abc1234' }), 'dev+abc1234');
  });

  it('falls back to dev when neither the version nor the commit is known', () => {
    assert.equal(resolveAppVersion({}), 'dev');
    assert.equal(resolveAppVersion({ version: '', commit: 'unknown' }), 'dev');
    assert.equal(resolveAppVersion({ version: '', commit: '' }), 'dev');
  });

  for (const bad of ['v1.5', 'latest', 'v2027.2.0-rc.1']) {
    it(`throws with the given value and the expected form for a malformed version ${bad}`, () => {
      assert.throws(
        () => resolveAppVersion({ version: bad, commit: 'abc1234' }),
        (error) => error instanceof Error && error.message.includes(bad) && error.message.includes('vX.Y.Z')
      );
    });
  }
});

describe('build wiring (changing the root package.json version does not change About)', () => {
  for (const pkg of ['editor', 'verify']) {
    it(`packages/${pkg}/vite.config.ts derives the version from TYPEDCODE_VERSION, not from package.json`, () => {
      const source = readFileSync(join(REPO_ROOT, 'packages', pkg, 'vite.config.ts'), 'utf8');
      assert.doesNotMatch(source, /package\.json/);
      assert.match(source, /resolveAppVersion\(/);
      assert.match(source, /TYPEDCODE_VERSION/);
    });
  }

  it('keeps the root package.json version at 0.0.0 (the build does not read it)', () => {
    const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(rootPkg.version, '0.0.0');
  });
});
