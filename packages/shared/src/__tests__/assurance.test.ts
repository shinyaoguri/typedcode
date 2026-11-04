/**
 * 三層保証語彙 (ADR-0020) の導出テスト。
 * deriveAssurance は純関数なので実体を直接使う。
 */

import { describe, expect, it } from 'vitest';
import { deriveAssurance, summarizeAnalysisForAssurance, type AssuranceInput } from '../assurance.js';

/** 健全な anchored casual proof の入力 (テストごとに上書きして崩す)。 */
function healthyInput(): AssuranceInput {
  return {
    metadataValid: true,
    chainValid: true,
    screenshotsTampered: 0,
    rootAnchored: true,
    signedCheckpoints: { anchored: true, valid: true, sparse: false, postHocSuspected: false, terminal: true },
    sessionTokenMismatch: false,
    isPureTyping: true,
    analysis: { reviewPriority: 0, notableSignals: 0 },
    // 既定は full モード相当 (PoSW を実際に再計算した)。
    poswSkipped: false,
  };
}

describe('deriveAssurance — integrity', () => {
  it('marks integrity proven when all cryptographic checks pass', () => {
    expect(deriveAssurance(healthyInput()).integrity).toBe('proven');
  });

  it('fails integrity when the hash chain is broken', () => {
    expect(deriveAssurance({ ...healthyInput(), chainValid: false }).integrity).toBe('failed');
  });

  it('fails integrity when metadata verification fails', () => {
    expect(deriveAssurance({ ...healthyInput(), metadataValid: false }).integrity).toBe('failed');
  });

  it('fails integrity when any screenshot is tampered', () => {
    expect(deriveAssurance({ ...healthyInput(), screenshotsTampered: 1 }).integrity).toBe('failed');
  });

  it('fails integrity when a provided exam package fails binding verification', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      exam: { present: true, packageProvided: true, bindingValid: false },
    };
    expect(deriveAssurance(input).integrity).toBe('failed');
  });

  it('keeps integrity proven for an exam proof when no package was provided', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      exam: { present: true, packageProvided: false },
    };
    expect(deriveAssurance(input).integrity).toBe('proven');
  });
});

/**
 * fast モード (#214): PoSW の反復再計算をスキップしたときは `proven` を名乗らない。
 * spec §8.2 が保証するのは「申告 PoSW 値が proof 全体とハッシュ的に一貫していること」までで、
 * 「実際に 10,000 回反復したか」は確認していない。ADR-0020 の「実証拠から導出する」に従い、
 * 検証していない分を語彙に反映する。
 */
describe('deriveAssurance — integrity (PoSW 未再計算)', () => {
  it('does not claim integrity proven when the PoSW recompute was skipped', () => {
    expect(deriveAssurance({ ...healthyInput(), poswSkipped: true }).integrity).toBe('partial');
  });

  it('still fails integrity when the chain is broken and the PoSW recompute was skipped', () => {
    const input: AssuranceInput = { ...healthyInput(), poswSkipped: true, chainValid: false };
    expect(deriveAssurance(input).integrity).toBe('failed');
  });

  it('still fails integrity when a screenshot is tampered and the PoSW recompute was skipped', () => {
    const input: AssuranceInput = { ...healthyInput(), poswSkipped: true, screenshotsTampered: 1 };
    expect(deriveAssurance(input).integrity).toBe('failed');
  });

  it('claims integrity proven only when the PoSW was actually recomputed', () => {
    expect(deriveAssurance({ ...healthyInput(), poswSkipped: false }).integrity).toBe('proven');
  });

  it('leaves temporal and provenance untouched when the PoSW recompute was skipped', () => {
    const full = deriveAssurance(healthyInput());
    const fast = deriveAssurance({ ...healthyInput(), poswSkipped: true });
    expect(fast.temporal).toBe(full.temporal);
    expect(fast.provenance).toEqual(full.provenance);
  });
});

describe('deriveAssurance — temporal', () => {
  it('reports anchored when root is server-anchored and checkpoints are dense and clean', () => {
    expect(deriveAssurance(healthyInput()).temporal).toBe('anchored');
  });

  it('downgrades to partial when anchoring density is sparse', () => {
    const input = healthyInput();
    input.signedCheckpoints!.sparse = true;
    expect(deriveAssurance(input).temporal).toBe('partial');
  });

  it('downgrades to partial when post-hoc batch signing is suspected', () => {
    const input = healthyInput();
    input.signedCheckpoints!.postHocSuspected = true;
    expect(deriveAssurance(input).temporal).toBe('partial');
  });

  it('downgrades to partial when the root is anchored but no signed checkpoints exist', () => {
    const input: AssuranceInput = { ...healthyInput(), signedCheckpoints: undefined };
    expect(deriveAssurance(input).temporal).toBe('partial');
  });

  it('downgrades to partial when checkpoints exist but the root is not anchored', () => {
    expect(deriveAssurance({ ...healthyInput(), rootAnchored: false }).temporal).toBe('partial');
  });

  it('reports unanchored when no server time evidence exists at all', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      rootAnchored: false,
      signedCheckpoints: undefined,
    };
    expect(deriveAssurance(input).temporal).toBe('unanchored');
  });

  it('does not count an invalid checkpoint chain as time evidence', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      rootAnchored: false,
      signedCheckpoints: { anchored: true, valid: false, terminal: true },
    };
    expect(deriveAssurance(input).temporal).toBe('unanchored');
  });

  it('uses the exam-t0 regime for exam proofs regardless of checkpoints', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      rootAnchored: false,
      signedCheckpoints: undefined,
      exam: { present: true, packageProvided: true, bindingValid: true },
    };
    expect(deriveAssurance(input).temporal).toBe('exam-t0');
  });

  it('does not grant exam-t0 to a self-declared exam block without the package (#131)', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      rootAnchored: false,
      signedCheckpoints: undefined,
      exam: { present: true, packageProvided: false },
    };
    expect(deriveAssurance(input).temporal).toBe('unanchored');
  });

  it('does not grant exam-t0 when the provided exam package fails binding verification (#131)', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      rootAnchored: false,
      signedCheckpoints: undefined,
      exam: { present: true, packageProvided: true, bindingValid: false },
    };
    expect(deriveAssurance(input).temporal).toBe('unanchored');
  });

  it('still derives server time evidence for an unverified exam claim (#131)', () => {
    // 未検証 exam でも実在するサーバ時刻証拠 (有効な署名 cp) は通常どおり数える。
    const input: AssuranceInput = {
      ...healthyInput(),
      rootAnchored: false,
      exam: { present: true, packageProvided: false },
    };
    expect(deriveAssurance(input).temporal).toBe('partial');
  });
});

/**
 * 未署名の末尾 (#295): 最後の署名 cp より後のイベントは、サーバ時刻の上界を持たない。
 * 先頭だけ署名して残りをオフラインで書き足した proof を `anchored` と呼ばない。
 */
describe('deriveAssurance — temporal (未署名の末尾, #295)', () => {
  it('downgrades to partial when the last signed checkpoint does not reach the final event', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      signedCheckpoints: { anchored: true, valid: true, sparse: false, postHocSuspected: false, terminal: false },
    };
    expect(deriveAssurance(input).temporal).toBe('partial');
  });

  it('keeps anchored when the last signed checkpoint covers the final event', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      signedCheckpoints: { anchored: true, valid: true, sparse: false, postHocSuspected: false, terminal: true },
    };
    expect(deriveAssurance(input).temporal).toBe('anchored');
  });

  it('still counts a valid checkpoint chain with an unsigned tail as some server time evidence', () => {
    const input: AssuranceInput = {
      ...healthyInput(),
      rootAnchored: false,
      signedCheckpoints: { anchored: true, valid: true, sparse: false, postHocSuspected: false, terminal: false },
    };
    expect(deriveAssurance(input).temporal).toBe('partial');
  });
});

/**
 * token と署名 cp の sessionId 不一致 (#295 / #329 後半, spec §6.3): 別セッションの cp は
 * この proof の時刻証拠にならない。改ざんではないので integrity には流さない。
 */
describe('deriveAssurance — temporal (sessionId 不一致)', () => {
  it('does not report anchored when the session token and signed checkpoints disagree on sessionId', () => {
    expect(deriveAssurance({ ...healthyInput(), sessionTokenMismatch: true }).temporal).toBe('partial');
  });

  it('does not count mismatched-session checkpoints as time evidence when the root is unanchored', () => {
    const input: AssuranceInput = { ...healthyInput(), rootAnchored: false, sessionTokenMismatch: true };
    expect(deriveAssurance(input).temporal).toBe('unanchored');
  });

  it('keeps integrity proven when only the sessionId disagrees', () => {
    expect(deriveAssurance({ ...healthyInput(), sessionTokenMismatch: true }).integrity).toBe('proven');
  });
});

describe('deriveAssurance — provenance (advisory)', () => {
  it('never elevates provenance into integrity or temporal', () => {
    const input = healthyInput();
    input.isPureTyping = false;
    input.analysis = { reviewPriority: 1, notableSignals: 5 };
    const result = deriveAssurance(input);
    expect(result.integrity).toBe('proven');
    expect(result.temporal).toBe('anchored');
  });

  it('reports null analysis fields when no analysis was run', () => {
    const input: AssuranceInput = { ...healthyInput(), analysis: undefined };
    const result = deriveAssurance(input);
    expect(result.provenance.notableSignals).toBeNull();
    expect(result.provenance.reviewPriority).toBeNull();
  });

  it('carries pureTyping through verbatim', () => {
    expect(deriveAssurance({ ...healthyInput(), isPureTyping: false }).provenance.pureTyping).toBe(false);
  });
});

describe('summarizeAnalysisForAssurance', () => {
  it('counts only signals above info severity as notable', () => {
    const summary = summarizeAnalysisForAssurance({
      reviewPriority: 0.4,
      signals: [{ severity: 'info' }, { severity: 'notice' }, { severity: 'review' }],
      analyzerStatus: { a: { status: 'ok' } },
    });
    expect(summary?.notableSignals).toBe(2);
    expect(summary?.reviewPriority).toBe(0.4);
  });

  it('reports analysis as not run when no analyzer finished ok (#301)', () => {
    const summary = summarizeAnalysisForAssurance({
      reviewPriority: 0,
      signals: [],
      analyzerStatus: { boom: { status: 'failed' }, hang: { status: 'timeout' }, bad: { status: 'invalid-output' } },
    });
    expect(summary).toBeUndefined();
  });

  it('keeps the summary when at least one analyzer finished ok next to failed ones (#301)', () => {
    const summary = summarizeAnalysisForAssurance({
      reviewPriority: 0,
      signals: [],
      analyzerStatus: { boom: { status: 'failed' }, quiet: { status: 'ok' } },
    });
    expect(summary).toEqual({ reviewPriority: 0, notableSignals: 0 });
  });

  it('leaves provenance null when every analyzer failed, so review 0% is not shown as no findings (#301)', () => {
    const result = deriveAssurance({
      ...healthyInput(),
      analysis: summarizeAnalysisForAssurance({
        reviewPriority: 0,
        signals: [],
        analyzerStatus: { boom: { status: 'failed' } },
      }),
    });
    expect(result.provenance.reviewPriority).toBeNull();
    expect(result.provenance.notableSignals).toBeNull();
  });
});
