/**
 * scripts/setup-exam-fixture.mjs の「用意済み」判定の検証 (#718)。
 *
 * 封印する平文 (BUNDLE) を変えたら、古い fixture を用意済みと見なさず作り直させる。
 * starter を空から非空に変えた後に古い package のまま走ると、exam の E2E が原因から離れた所で落ちる。
 * 実行: `node --test packages/e2e/scripts/setup-exam-fixture.test.mjs` (CI は check job)。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BUNDLE, isFixtureComplete } from './setup-exam-fixture.mjs';

let dir;

function writeFixture(fixtureJson) {
  for (const f of ['authority-keys.mjs', 'p1.tcexam', 'other.tcexam']) writeFileSync(join(dir, f), '');
  writeFileSync(join(dir, 'fixture.json'), fixtureJson);
}

describe('isFixtureComplete', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-exam-fixture-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a fixture sealed from the current bundle as complete', () => {
    writeFixture(JSON.stringify({ bundle: BUNDLE }));
    assert.equal(isFixtureComplete(dir), true);
  });

  it('treats a fixture sealed from a different bundle (e.g. the old empty starter) as incomplete', () => {
    const stale = structuredClone(BUNDLE);
    stale.problems[0].starter.content = '';
    writeFixture(JSON.stringify({ bundle: stale }));
    assert.equal(isFixtureComplete(dir), false);
  });

  it('treats a fixture without a recorded bundle as incomplete', () => {
    writeFixture(JSON.stringify({ code: 'E2ETEST1' }));
    assert.equal(isFixtureComplete(dir), false);
  });

  it('treats an unreadable fixture.json as incomplete', () => {
    writeFixture('{not json');
    assert.equal(isFixtureComplete(dir), false);
  });
});
