/**
 * 分析器が失敗・期限切れでも、Web の検証は結果を返す (#301)。
 *
 * Worker は `runProofVerification` の後に結果を UI へ返すので、ここで `runAnalysis` が待ち続けると
 * 検証結果ごと画面に出ない。分析器ごとの期限 (shared の `ANALYZER_TIMEOUT_MS`) で timeout として
 * 記録して先へ進むこと、検証の結論 (`valid`) が分析の失敗で変わらないことを見る。
 * 期限は Web では注入しない (既定の 10 秒) ので、fake timers で時間を進める。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ANALYZER_TIMEOUT_MS, type Analyzer } from '@typedcode/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProofFile } from '../../types.js';
import { buildAssuranceInput, runProofVerification } from '../proofVerification.js';

const CLI_ROOT = resolve(process.cwd(), '../verify-cli');
const VALID = readFileSync(join(CLI_ROOT, 'src/__tests__/fixtures/proofs/valid.json'), 'utf-8');

function validProof(): ProofFile {
  return JSON.parse(VALID) as ProofFile;
}

const boom: Analyzer = {
  id: 'boom',
  version: '1.0.0',
  analyze: () => {
    throw new Error('analyzer failure');
  },
};

/** 解決しない Promise を返す分析器。呼ばれたこと (= 期限のタイマーが張られた後) を `started` で知らせる。 */
function hangingAnalyzer(): { analyzer: Analyzer; started: Promise<void> } {
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const analyzer: Analyzer = {
    id: 'hang',
    version: '1.0.0',
    analyze: () => {
      markStarted();
      return new Promise(() => {});
    },
  };
  return { analyzer, started };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runProofVerification with analyzers that cannot finish (#301)', () => {
  it('returns the verification result with the throwing analyzer recorded as failed', async () => {
    const baseline = await runProofVerification(validProof(), { mode: 'fast', analyzers: [] });

    const result = await runProofVerification(validProof(), { mode: 'fast', analyzers: [boom] });

    expect(result.valid).toBe(baseline.valid);
    expect(result.valid).toBe(true);
    expect(result.analysis?.analyzerStatus['boom']?.status).toBe('failed');
  });

  it('returns the verification result after the default deadline when an analyzer never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const hang = hangingAnalyzer();

    const pending = runProofVerification(validProof(), { mode: 'fast', analyzers: [hang.analyzer] });
    // 検証本体は暗号ハッシュの非同期処理で進むので、分析器が呼ばれるまで待ってから時計を進める。
    await hang.started;
    await vi.advanceTimersByTimeAsync(ANALYZER_TIMEOUT_MS);
    const result = await pending;

    expect(result.valid).toBe(true);
    expect(result.analysis?.analyzerStatus['hang']?.status).toBe('timeout');
  });

  it('does not count a failed-only analysis as review priority 0 in the assurance input', async () => {
    const result = await runProofVerification(validProof(), { mode: 'fast', analyzers: [boom] });

    expect(buildAssuranceInput(result).analysis).toBeUndefined();
  });
});
