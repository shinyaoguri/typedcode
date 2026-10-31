/**
 * 複数の位置引数の扱い (#294)。
 *
 * かつて CLI は `positional[0]` だけを処理し、2 件目以降を読みもせずに捨てていた。
 * `valid.json broken.json` が exit 0 になり、採点スクリプトが未検証の提出物を成功と読めた
 * (しかも順序を逆にすると結論が変わった)。README は `file1.json file2.zip` を案内している。
 * 契約: 位置引数は**すべて**検証し、読めない・壊れている入力は他の入力を止めずに失敗として数え、
 * 1 件でも失敗があれば exit 1。
 *
 * 子プロセスで起動する (終了コードは実プロセスの終わり方で決まる, #283)。
 */

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runSourceCli, writeBrokenProof } from './helpers/runCli.js';

const VALID = fixture('proofs', 'valid.json');
const TAMPERED = fixture('proofs', 'tampered.json');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tc-verify-cli-inputs-'));
}

/** 有効 proof の別名コピー (同一内容・別パス) */
function validCopy(name = 'valid2.json'): string {
  const path = join(tempDir(), name);
  copyFileSync(VALID, path);
  return path;
}

const MISSING = join(tempDir(), 'does-not-exist.json');

describe('multiple positional inputs (#294)', () => {
  it('valid + missing file exits 1 and names the missing file', () => {
    const res = runSourceCli([VALID, MISSING]);
    expect(res.exitCode).toBe(1);
    expect(`${res.stdout}\n${res.stderr}`).toContain('does-not-exist.json');
  });

  it('valid + broken proof exits 1', () => {
    const res = runSourceCli([VALID, writeBrokenProof()]);
    expect(res.exitCode).toBe(1);
  });

  it('valid + tampered proof exits 1', () => {
    expect(runSourceCli([VALID, TAMPERED]).exitCode).toBe(1);
  });

  it('valid + unsupported extension exits 1', () => {
    const txt = join(tempDir(), 'extra.txt');
    writeFileSync(txt, 'x', 'utf-8');
    const res = runSourceCli([VALID, txt]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('Unsupported file type');
  });

  it('valid + corrupt ZIP exits 1', () => {
    const zip = join(tempDir(), 'mixed.zip');
    writeFileSync(zip, 'not a zip', 'utf-8');
    expect(runSourceCli([VALID, zip]).exitCode).toBe(1);
  });

  it('two valid proofs exit 0 and both appear verified in the summary', () => {
    const second = validCopy();
    const res = runSourceCli([VALID, second]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('=== Summary: 2/2 proofs passed ===');
    expect(res.stdout).toContain(`✓ ${VALID}`);
    expect(res.stdout).toContain(`✓ ${second}`);
  });

  it('a failing input does not stop the remaining inputs from being verified', () => {
    const second = validCopy();
    const res = runSourceCli([MISSING, second]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('=== Summary: 1/2 proofs passed ===');
    expect(res.stdout).toContain(`✓ ${second}`);
    expect(res.stdout).toContain('✗');
  });

  it('never exits 0 with an unverified input, whatever the argument order', () => {
    const second = validCopy();
    const bad = [MISSING, writeBrokenProof(), TAMPERED];
    for (const b of bad) {
      for (const order of [
        [VALID, b],
        [b, VALID],
        [VALID, b, second],
        [b, VALID, second],
        [VALID, second, b],
      ]) {
        const res = runSourceCli(order);
        expect(res.exitCode, `args: ${order.join(' ')}`).toBe(1);
      }
    }
    // 子プロセスを 15 回起動するので、既定の 5 秒では足りない
  }, 60_000);

  it('options apply to every input (--mode fast)', () => {
    const second = validCopy();
    const res = runSourceCli([VALID, second, '--mode', 'fast']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('=== Summary: 2/2 proofs passed ===');
  });

  it('--analysis-json / --analysis-bundle filenames match the inputs and are unique', () => {
    const second = validCopy();
    const dir = tempDir();
    const json = join(dir, 'analysis.json');
    const bundle = join(dir, 'bundle.json');
    const res = runSourceCli([VALID, second, '--analysis-json', json, '--analysis-bundle', bundle]);
    expect(res.exitCode).toBe(0);
    for (const out of [json, bundle]) {
      const names = (JSON.parse(readFileSync(out, 'utf-8')) as Array<{ filename: string }>).map((e) => e.filename);
      expect(names).toEqual([VALID, second]);
    }
  });

  it('a single input keeps its previous output shape (no Summary block)', () => {
    const res = runSourceCli([VALID]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('=== Summary');
  });

  it('a single missing input still exits 1 with an error', () => {
    const res = runSourceCli([MISSING]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('does-not-exist.json');
  });
});
