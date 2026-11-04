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
 *
 * #301 で分析器ごとに期限 (shared の `ANALYZER_TIMEOUT_MS` = 10 秒) が付いたので、解決しない
 * analyzer を差しても期限後に検証結果を最後まで出して終わる。CLI オプションで期限を縮められないので、
 * このケースだけ実時間で 10 秒待つ (個別の timeout を長めに取る)。
 */

import { describe, expect, it } from 'vitest';
import { type CliRun, fixture, runSourceCli } from './helpers/runCli.js';

const TAMPERED = fixture('proofs', 'tampered.json');
const VALID = fixture('proofs', 'valid.json');

/** 解決しない analyzer の実行は 10 秒かかるので、1 回だけ走らせて両方のケースで読む。 */
let hangRun: CliRun | undefined;
function runWithHangingAnalyzer(): CliRun {
  hangRun ??= runSourceCli(['--analyzer', fixture('analyzers', 'hang.mjs'), TAMPERED]);
  return hangRun;
}

describe('CLI exit code as a process (#315)', () => {
  it('a never-settling external analyzer cannot let a tampered proof exit 0', { timeout: 30_000 }, () => {
    expect(runWithHangingAnalyzer().exitCode).toBe(1);
  });

  it('a never-settling external analyzer times out and the verification result is still printed (#301)', {
    timeout: 30_000,
  }, () => {
    const res = runWithHangingAnalyzer();
    expect(res.stdout).toContain('Verification FAILED');
    expect(res.stdout).toContain('Analysis unavailable: hang (timeout)');
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
