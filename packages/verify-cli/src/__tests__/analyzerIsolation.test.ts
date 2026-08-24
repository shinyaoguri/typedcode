/**
 * 外部 analyzer が検証結果に触れないことの固定 (#283 c3 / 旧 #238)。
 *
 * ADR-0009 / ADR-0023 の不変条件は「分析層は advisory であって判定ではない」。ところが
 * `AnalysisInput.verification` は検証結果オブジェクトそのものなので、以前は `--analyzer` で
 * 渡した分析器が `input.verification.valid = true` と書くだけで **改ざん proof が exit 0** になり、
 * 三層保証の integrity や表示上の統計まで汚染できた。
 *
 * 守り方は二重で、どちらが破れても事故にならないようにしてある:
 *   1. 検証結果を deep freeze してから分析層へ渡す (書き込みは TypeError で弾かれる)
 *   2. 判定に効く値は分析層より**前**にすべて確定させる (順序で保証する)
 *
 * ここでは「悪意ある分析器を通しても結論が変わらない」ことだけを見る。分析器の読み込み契約は
 * `analyzers.test.ts`、advisory と判定の分離そのものは shared の `assurance.test.ts` が持つ。
 */

import { describe, expect, it, vi } from 'vitest';
import { TypingProof, computeHash, type Analyzer, type FingerprintComponents } from '@typedcode/shared';
import { verifyProof, type ProofFile } from '../verify.js';

/**
 * PoSW 用 Web Worker のスタブ (webCliParity.test.ts と同じ役割)。Node 環境に Worker は無い。
 * 検証はすべて `mode: 'fast'` (PoSW 再計算なし) で回すので、返す値は固定で構わない。
 */
class PoswWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (!this.onmessage) return;
      const data =
        message.type === 'compute-posw'
          ? {
              type: 'posw-result',
              requestId: message.requestId,
              iterations: message.iterations,
              nonce: 'ab'.repeat(16),
              intermediateHash: 'stub-intermediate-hash',
              computeTimeMs: 1,
            }
          : { type: 'verify-result', requestId: message.requestId, valid: true };
      this.onmessage({ data } as MessageEvent);
    });
  }

  terminate(): void {
    // no-op
  }
}

vi.stubGlobal('Worker', PoswWorkerStub);

const components = (): FingerprintComponents =>
  ({
    userAgent: 'Mozilla/5.0 (Analyzer Isolation Test)',
    language: 'en',
    languages: ['en'],
    platform: 'TestOS',
    hardwareConcurrency: 4,
    deviceMemory: 8,
    screen: {
      width: 1440,
      height: 900,
      availWidth: 1440,
      availHeight: 860,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 2,
    },
    timezone: 'UTC',
    timezoneOffset: 0,
    canvas: 'mock-canvas',
    webgl: { vendor: 'Mock', renderer: 'Mock' },
    fonts: ['Arial'],
    cookieEnabled: true,
    doNotTrack: 'unspecified',
    maxTouchPoints: 0,
  }) as FingerprintComponents;

/** 打鍵して proof を 1 本作る。 */
async function buildProof(text: string): Promise<ProofFile> {
  const fp = components();
  const fingerprintHash = await computeHash(JSON.stringify(fp, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, fp);
  let content = '';
  for (const ch of text) {
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }
  const exported = await proof.exportProof(content);
  return { ...exported, content, language: 'text' } as ProofFile;
}

/** チェーンを壊した proof (検証は必ず落ちる)。 */
async function buildTamperedProof(): Promise<ProofFile> {
  const proof = await buildProof('hello');
  const events = proof.proof.events;
  const target = events[events.length - 1]!;
  // 記録済みイベントの中身だけ差し替える → hash 再計算と合わなくなる。
  return {
    ...proof,
    proof: {
      ...proof.proof,
      events: [...events.slice(0, -1), { ...target, data: 'X' }],
    },
  } as ProofFile;
}

/**
 * 検証結果を書き換えにかかる分析器。判定に効く boolean は**反転**させる — 固定値を書くと
 * 「もともとその値だった」ケースで退行を見逃すため (改ざん proof なら false→true、
 * 健全な proof なら true→false になり、どちらでも結論の汚染が観測できる)。
 * 凍結されていれば代入は TypeError で throw し、orchestrator が握り潰す。
 */
const hostileAnalyzer: Analyzer = {
  id: 'hostile-fixture',
  version: '1.0.0',
  analyze(input) {
    const verification = input.verification as unknown as Record<string, unknown>;
    for (const key of ['valid', 'chainValid', 'metadataValid', 'isPureTyping', 'poswSkipped']) {
      try {
        verification[key] = !verification[key];
      } catch {
        // 凍結済み。ここを通るのが期待どおりの姿。
      }
    }
    try {
      verification.errorMessage = 'injected by analyzer';
    } catch {
      // 同上。
    }
    return [];
  },
};

describe('外部 analyzer の隔離 (#283 c3)', () => {
  it('改ざん proof は、検証結果を書き換えにくる分析器を通しても invalid のまま', async () => {
    const tampered = await buildTamperedProof();

    const baseline = await verifyProof(tampered, { mode: 'fast' });
    expect(baseline.valid).toBe(false);
    expect(baseline.chainValid).toBe(false);

    const withHostile = await verifyProof(tampered, { mode: 'fast', analyzers: [hostileAnalyzer] });

    // exit code を決める値 (cli.ts は summary.every(s => s.valid) で 0/1 を出す)。
    expect(withHostile.valid).toBe(false);
    expect(withHostile.chainValid).toBe(false);
    // 三層保証の integrity も advisory に引きずられない。
    expect(withHostile.assurance.integrity).toBe('failed');
    // 失敗の理由も消せない (採点者に「なぜ落ちたか」が届かなくなるため)。
    expect(withHostile.errorMessage).toBe(baseline.errorMessage);
  });

  it('健全な proof でも、分析器の書き込みで表示上の統計が変わらない', async () => {
    const healthy = await buildProof('hello world');

    const baseline = await verifyProof(healthy, { mode: 'fast' });
    const withHostile = await verifyProof(healthy, { mode: 'fast', analyzers: [hostileAnalyzer] });

    expect(baseline.valid).toBe(true);
    expect(withHostile.valid).toBe(true);
    expect(withHostile.errorMessage).toBe(baseline.errorMessage);
    expect(withHostile.pasteEvents).toBe(baseline.pasteEvents);
    expect(withHostile.dropEvents).toBe(baseline.dropEvents);
    expect(withHostile.isPureTyping).toBe(baseline.isPureTyping);
    expect(withHostile.assurance).toEqual(baseline.assurance);
  });

  it('行儀の悪い分析器が throw しても、他の分析器のシグナルは失われない', async () => {
    const healthy = await buildProof('hi');

    const witness: Analyzer = {
      id: 'witness-fixture',
      version: '1.0.0',
      analyze: () => [{ id: 'witness', severity: 'info', summary: 'ran' }],
    };

    const result = await verifyProof(healthy, { mode: 'fast', analyzers: [hostileAnalyzer, witness] });

    expect(result.analysis.signals.some((s) => s.id === 'witness')).toBe(true);
  });
});
