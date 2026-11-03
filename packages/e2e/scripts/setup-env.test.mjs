/**
 * scripts/setup-env.mjs (E2E の環境準備) の検証。
 *
 * e2e パッケージは vitest を持たないので node:test で書く。実行: `node --test packages/e2e/scripts/setup-env.test.mjs`
 * (CI は deploy.yml の check job)。リポジトリの実ファイルには触れず、一時ディレクトリを root に渡す。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isKeyIdRegistered, readSigningKeyId, setupEnv } from './setup-env.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHECKPOINT_EXAMPLE = 'packages/shared/src/checkpointKeys/localKeys.ts.example';
const EXAM_EXAMPLE = 'packages/shared/src/examAuthorityKeys/localKeys.ts.example';

const SECRET_JWK = '{"kty":"EC","crv":"P-256","d":"SECRET-D-VALUE","x":"xx","y":"yy"}';
const EMPTY_LOCAL_KEYS = 'export const LOCAL_CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [];\n';
const REGISTRY = "export const CHECKPOINT_PUBLIC_KEYS = [{ keyId: 'tcp-prod-2026', status: 'active' }];\n";

let root;

function paths() {
  return {
    devVars: join(root, 'packages/workers/.dev.vars'),
    registry: join(root, 'packages/shared/src/checkpointKeys/registry.ts'),
    localKeys: join(root, 'packages/shared/src/checkpointKeys/localKeys.ts'),
    examLocalKeys: join(root, 'packages/shared/src/examAuthorityKeys/localKeys.ts'),
    editorEnv: join(root, 'packages/editor/.env'),
  };
}

function devVarsWith(keyIdLine) {
  return ['TURNSTILE_SECRET_KEY=t', keyIdLine, `CHECKPOINT_SIGNING_KEY_JWK=${SECRET_JWK}`, ''].join('\n');
}

async function run() {
  const out = [];
  const code = await setupEnv({ root, log: (m) => out.push(m), error: (m) => out.push(m) });
  return { code, output: out.join('\n') };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'e2e-setup-'));
  const p = paths();
  mkdirSync(join(root, 'packages/workers'), { recursive: true });
  mkdirSync(join(root, 'packages/shared/src/checkpointKeys'), { recursive: true });
  mkdirSync(join(root, 'packages/shared/src/examAuthorityKeys'), { recursive: true });
  mkdirSync(join(root, 'packages/editor'), { recursive: true });
  // setup は最初に無い localKeys.ts を .example から作る (#338)。実リポの .example をそのまま置く
  for (const example of [CHECKPOINT_EXAMPLE, EXAM_EXAMPLE]) copyFileSync(join(REPO_ROOT, example), join(root, example));
  writeFileSync(p.registry, REGISTRY);
  writeFileSync(p.localKeys, EMPTY_LOCAL_KEYS);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readSigningKeyId', () => {
  it('reads the value and strips surrounding quotes', () => {
    assert.equal(readSigningKeyId(devVarsWith('CHECKPOINT_SIGNING_KEY_ID=tcp-e2e-abc')), 'tcp-e2e-abc');
    assert.equal(readSigningKeyId(devVarsWith('CHECKPOINT_SIGNING_KEY_ID="tcp-e2e-abc"')), 'tcp-e2e-abc');
  });

  it('returns null when the line is missing or empty', () => {
    assert.equal(readSigningKeyId('TURNSTILE_SECRET_KEY=t\n'), null);
    assert.equal(readSigningKeyId(devVarsWith('CHECKPOINT_SIGNING_KEY_ID=')), null);
  });
});

describe('isKeyIdRegistered', () => {
  it('matches only a quoted occurrence (not a prefix of another keyId)', () => {
    assert.equal(isKeyIdRegistered('tcp-prod-2026', [REGISTRY]), true);
    assert.equal(isKeyIdRegistered('tcp-prod', [REGISTRY]), false);
  });
});

describe('setupEnv with an existing .dev.vars', () => {
  it('fails when the keyId is in neither registry.ts nor localKeys.ts, without touching files or leaking the JWK', async () => {
    const p = paths();
    const devVars = devVarsWith('CHECKPOINT_SIGNING_KEY_ID=tcp-e2e-stale');
    writeFileSync(p.devVars, devVars);

    const { code, output } = await run();

    assert.equal(code, 1);
    assert.match(output, /tcp-e2e-stale/);
    assert.match(output, /npm run setup -w @typedcode\/e2e/);
    assert.doesNotMatch(output, /SECRET-D-VALUE/);
    assert.equal(readFileSync(p.devVars, 'utf8'), devVars);
    assert.equal(readFileSync(p.localKeys, 'utf8'), EMPTY_LOCAL_KEYS);
  });

  it('fails when CHECKPOINT_SIGNING_KEY_ID is empty', async () => {
    writeFileSync(paths().devVars, devVarsWith('CHECKPOINT_SIGNING_KEY_ID='));

    const { code, output } = await run();

    assert.equal(code, 1);
    assert.doesNotMatch(output, /SECRET-D-VALUE/);
  });

  it('succeeds without changes when the keyId is in localKeys.ts', async () => {
    const p = paths();
    const devVars = devVarsWith('CHECKPOINT_SIGNING_KEY_ID=tcp-e2e-local');
    const localKeys = `export const LOCAL_CHECKPOINT_PUBLIC_KEYS = [{"keyId":"tcp-e2e-local"}];\n`;
    writeFileSync(p.devVars, devVars);
    writeFileSync(p.localKeys, localKeys);

    const { code } = await run();

    assert.equal(code, 0);
    assert.equal(readFileSync(p.devVars, 'utf8'), devVars);
    assert.equal(readFileSync(p.localKeys, 'utf8'), localKeys);
    assert.equal(existsSync(p.editorEnv), false);
  });

  it('succeeds without changes when the keyId is in registry.ts', async () => {
    const p = paths();
    writeFileSync(p.devVars, devVarsWith('CHECKPOINT_SIGNING_KEY_ID=tcp-prod-2026'));

    const { code } = await run();

    assert.equal(code, 0);
    assert.equal(readFileSync(p.localKeys, 'utf8'), EMPTY_LOCAL_KEYS);
  });
});

describe('setupEnv without .dev.vars', () => {
  it('generates a key whose keyId is registered in localKeys.ts, so a re-run passes the check', async () => {
    const p = paths();

    const first = await run();
    assert.equal(first.code, 0);

    const keyId = readSigningKeyId(readFileSync(p.devVars, 'utf8'));
    assert.match(keyId ?? '', /^tcp-e2e-/);
    assert.equal(isKeyIdRegistered(keyId, [readFileSync(p.localKeys, 'utf8')]), true);
    assert.match(readFileSync(p.editorEnv, 'utf8'), /VITE_API_URL=/);

    const second = await run();
    assert.equal(second.code, 0);
  });
});

describe('setupEnv and the local key files (#338)', () => {
  it('creates the exam authority localKeys.ts from its example even when .dev.vars already exists', async () => {
    const p = paths();
    writeFileSync(p.devVars, devVarsWith('CHECKPOINT_SIGNING_KEY_ID=tcp-prod-2026'));

    const { code } = await run();

    assert.equal(code, 0);
    assert.equal(readFileSync(p.examLocalKeys, 'utf8'), readFileSync(join(root, EXAM_EXAMPLE), 'utf8'));
  });

  it('leaves git status clean in a checkout that has the repository .gitignore', async () => {
    const git = (...args) =>
      execFileSync(
        'git',
        ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', ...args],
        { cwd: root, encoding: 'utf8' }
      );
    // 生成ルート (.dev.vars 無し) は localKeys.ts を両方とも作り、checkpoint の方は鍵を書き込む
    rmSync(paths().localKeys);
    copyFileSync(join(REPO_ROOT, '.gitignore'), join(root, '.gitignore'));
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fixture');

    const { code } = await run();

    assert.equal(code, 0);
    assert.equal(existsSync(paths().examLocalKeys), true);
    assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  });
});
