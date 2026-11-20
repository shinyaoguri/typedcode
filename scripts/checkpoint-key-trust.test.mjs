/**
 * scripts/checkpoint-key-trust.mjs (verify のビルドが staging の鍵を信頼するか。#321) の検証。
 * 実行: `node --test scripts/checkpoint-key-trust.test.mjs` (CI は check job が scripts/*.test.mjs を回す)。
 *
 * 本番の verify が staging の鍵を信頼しないことは、次の 3 つがそろって成り立つ:
 * 1. 値の解釈 (未指定は false) — resolveTrustStagingKeys
 * 2. verify の vite.config.ts が環境変数をこの関数に通して define に焼く
 * 3. deploy.yml が production のビルドに環境変数を渡さず、staging と PR プレビューのビルドにだけ true を渡す
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveTrustStagingKeys } from './checkpoint-key-trust.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveTrustStagingKeys', () => {
  it('does not trust staging keys when the variable is not given', () => {
    assert.equal(resolveTrustStagingKeys(undefined), false);
  });

  it('treats an empty or blank value as not given', () => {
    assert.equal(resolveTrustStagingKeys(''), false);
    assert.equal(resolveTrustStagingKeys('   '), false);
  });

  it('trusts staging keys only for the exact value true', () => {
    assert.equal(resolveTrustStagingKeys('true'), true);
  });

  it('does not trust staging keys for the value false', () => {
    assert.equal(resolveTrustStagingKeys('false'), false);
  });

  for (const bad of ['1', 'yes', 'TRUE', 'staging']) {
    it(`throws instead of guessing for the value ${bad}`, () => {
      assert.throws(() => resolveTrustStagingKeys(bad), /TYPEDCODE_TRUST_STAGING_KEYS/);
    });
  }
});

describe('wiring of the staging key trust into the verify build', () => {
  it('bakes the resolved value into the verify bundle through a Vite define', () => {
    const source = readFileSync(join(REPO_ROOT, 'packages/verify/vite.config.ts'), 'utf8');

    assert.match(
      source,
      /__TYPEDCODE_TRUST_STAGING_KEYS__:\s*JSON\.stringify\(\s*resolveTrustStagingKeys\(process\.env\.TYPEDCODE_TRUST_STAGING_KEYS\)/
    );
  });

  /** deploy.yml の `- name: <name>` の step の本文 (次の step の手前まで) */
  function stepBody(workflow, name) {
    const start = workflow.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, `${name} の step が無い`);
    const next = workflow.indexOf('\n      - ', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  }

  it('does not pass the variable to the production build', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');

    assert.doesNotMatch(stepBody(workflow, 'Build (production API)'), /TYPEDCODE_TRUST_STAGING_KEYS/);
  });

  it('passes true to every build that talks to the staging API (staging deploy and PR preview)', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
    const stagingSteps = workflow.split('- name: Build (staging API)').slice(1);

    assert.equal(stagingSteps.length, 2, 'staging API のビルドは deploy-staging と build-preview の 2 つ');
    for (const step of stagingSteps) {
      const body = step.slice(0, step.indexOf('\n      - '));
      assert.match(body, /TYPEDCODE_TRUST_STAGING_KEYS: 'true'/);
    }
  });
});
