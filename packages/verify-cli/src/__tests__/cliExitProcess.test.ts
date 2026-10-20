/**
 * 実プロセスとしての終了コードの固定 (#315)。
 *
 * #283 で `process.exit()` をやめ、`process.exitCode` を立ててイベントループが空になるのを待つ
 * 「自然終了」が正規の終了経路になった。すると、集計 (`summary.every(...)`) にも catch にも
 * 到達しないまま終わったプロセスは `exitCode` の**既定値**で終わる。既定が 0 だと、解決しない
 * Promise を返す `--analyzer` (悪意でもバグでも) を 1 つ差すだけで、改ざん proof が
 * `Loading proof file...` のまま exit 0 になった (fail-open)。
 *
 * 直し方は `main()` 冒頭で `process.exitCode = 1` にし、成功の集計でだけ 0 に下ろすこと。
 * ソース上の位置は `exitCode.test.ts` が、ここでは実際の終了コードを見る。
 * analyzer のタイムアウトや失敗の扱いそのものは #301 の領分 — ここは「途中で終わったら 0 ではない」だけ。
 */

import { describe, expect, it } from 'vitest';
import { fixture, runSourceCli } from './helpers/runCli.js';

const TAMPERED = fixture('proofs', 'tampered.json');
const VALID = fixture('proofs', 'valid.json');

describe('CLI exit code as a process (#315)', () => {
  it('a never-settling external analyzer cannot let a tampered proof exit 0', () => {
    const res = runSourceCli(['--analyzer', fixture('analyzers', 'hang.mjs'), TAMPERED]);
    expect(res.exitCode).toBe(1);
  });

  it('a tampered proof exits 1 without any external analyzer', () => {
    const res = runSourceCli([TAMPERED]);
    expect(res.exitCode).toBe(1);
  });

  it('a valid proof with a well-behaved external analyzer exits 0', () => {
    const res = runSourceCli(['--analyzer', fixture('analyzers', 'valid-default.mjs'), VALID]);
    expect(res.exitCode).toBe(0);
  });

  it('--help exits 0', () => {
    const res = runSourceCli(['--help']);
    expect(res.exitCode).toBe(0);
  });
});
