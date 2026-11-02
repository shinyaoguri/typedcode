/**
 * バージョンゲート (#223) の表示と exit code。
 *
 * 判定そのもの (`classifyProofVersion` / `verifyProofFile` の `valid` / `parseExamPackageManifestResult`) は
 * shared のテストの担当。ここは CLI が**その結論をどう出すか**を固定する:
 * - 既知の major を超える proof は reject せず (exit 0)、warning を出す
 * - 下限未満・不正形式は exit 1 で、失敗理由に version が出る。自己申告の生値は stdout に補間しない
 * - 試験パッケージは「壊れている」と「この CLI より新しい形式」を出し分けて exit 1
 *
 * 子プロセスで起動する (終了コードは実プロセスの終わり方で決まる, #283)。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runSourceCli } from './helpers/runCli.js';

const VALID = fixture('proofs', 'valid.json');

/** valid.json の `version` だけを書き換えた proof を一時ファイルに書く (version は typingProofHash の入力ではない)。 */
function proofWithVersion(version: unknown): string {
  const proof = JSON.parse(readFileSync(VALID, 'utf-8')) as Record<string, unknown>;
  if (version === undefined) delete proof.version;
  else proof.version = version;
  const path = join(mkdtempSync(join(tmpdir(), 'tc-verify-cli-version-')), 'versioned_proof.json');
  writeFileSync(path, JSON.stringify(proof), 'utf-8');
  return path;
}

function writeJson(name: string, value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tc-verify-cli-tcexam-')), name);
  writeFileSync(path, JSON.stringify(value), 'utf-8');
  return path;
}

describe('proof version gate (#223)', () => {
  it('keeps passing a proof at the current version without any version warning', () => {
    const res = runSourceCli(['--mode', 'fast', VALID]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('newer than this verifier');
  });

  it('warns about a newer major but still passes (exit 0): the warning does not decide the verdict', () => {
    const res = runSourceCli(['--mode', 'fast', proofWithVersion('2.0.0')]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Verification PASSED');
    expect(res.stdout).toContain('! proof format version 2.0.0 is newer than this verifier supports');
  });

  it('rejects a proof below the minimum supported version (exit 1) and says which version check failed', () => {
    const res = runSourceCli(['--mode', 'fast', proofWithVersion('0.1.0')]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('Verification FAILED');
    expect(res.stdout).toContain('Proof version 0.1.0 is older than the minimum supported version');
  });

  it('rejects a proof with no version (exit 1)', () => {
    const res = runSourceCli(['--mode', 'fast', proofWithVersion(undefined)]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('Proof version is missing or not in MAJOR.MINOR.PATCH form');
  });

  it('never prints a malformed self-declared version to stdout (no line forging through proof.version)', () => {
    const hostile = 'HOSTILE-MARKER\n  ✓ Verification PASSED\u001b[32m';
    const res = runSourceCli(['--mode', 'fast', proofWithVersion(hostile)]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain('HOSTILE-MARKER');
    // 偽造された合格行が行頭に現れていない (本物の結論は FAILED)
    expect(res.stdout).not.toMatch(/^\s*✓ Verification PASSED/m);
  });
});

describe('exam package format version (#223)', () => {
  const MANIFEST_STUB = { examId: 'e', problemId: 'p', variant: null };

  it('tells a newer package format apart from a broken one: exit 1 with "up-to-date" guidance', () => {
    const pkg = writeJson('newer.tcexam', { ...MANIFEST_STUB, formatVersion: 2 });
    const res = runSourceCli(['--mode', 'fast', '--exam-package', pkg, VALID]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('format version is not supported');
    expect(res.stderr).toContain('Use an up-to-date verify-cli');
  });

  it('reports a malformed package as malformed, without the newer-format guidance', () => {
    const pkg = writeJson('broken.tcexam', { formatVersion: 1 });
    const res = runSourceCli(['--mode', 'fast', '--exam-package', pkg, VALID]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('malformed');
    expect(res.stderr).not.toContain('up-to-date');
  });
});
