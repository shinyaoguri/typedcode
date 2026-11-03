/**
 * root アンカーの照合 (ADR-0017) と full モードの PoSW 検証の「拒否の分岐」のテスト (#496 / #467 系統 1・2)。
 *
 * どちらも判定を外しても既存のテストが緑のままだった (変異検査で生き残った):
 * - 系統 1: `verifyInitialHashRoot` の `rootUsedByEvents !== expectedInitialHash`。外すと、別セッションで
 *   記録したチェーンを、正規の typingProofData (root) に接ぎ木できてしまう。
 * - 系統 2: `verifyChain` の `!poswValid`。既存の `verifyChainModes.test.ts` は `intermediateHash` だけを
 *   書き換えて `event.hash` を再計算しないため、PoSW ではなく Hash mismatch で落ちていた。
 *
 * 前提: vitest の `setup.ts` は Worker を偽データを返す MockWorker に差し替えているので、`TypingProof` で
 * 記録した proof の PoSW は本物ではない (full モードで常に不一致)。full モードの正の対照が要るので、
 * 検証側と同じ同期 SHA-256 反復 (`iterateSha256HexSync`) で PoSW を焼き直した本物のチェーンを組む。
 */

import { describe, expect, it } from 'vitest';
import {
  POSW_ITERATIONS,
  TypingProof,
  computeHash,
  deterministicStringify,
  verifyChain,
  verifyInitialHashRoot,
  verifyProofFile,
  type ExportedProof,
  type FingerprintComponents,
  type PoSWData,
  type StoredEvent,
} from '../index.js';
import { iterateSha256HexSync } from '../utils/hashUtils.js';
import { pickHashedEventFields } from '../verification.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (RootAnchorAndPosw Test)',
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
});

type ProofFileInput = ExportedProof & { content: string; language: string };

async function buildProof(charCount = 3): Promise<ProofFileInput> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);
  let content = '';
  for (let i = 0; i < charCount; i++) {
    const ch = String.fromCharCode('a'.charCodeAt(0) + i);
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
  return { ...exported, content, language: 'text' };
}

interface RechainOptions {
  /** events[0].previousHash (チェーンの起点)。省略時は元のまま */
  root?: string;
  /** 指定したイベントの PoSW を、焼いた直後に書き換える (そのイベントの hash 以降は再計算される) */
  tamperPosw?: { index: number; mutate: (posw: PoSWData) => PoSWData };
}

/**
 * 全イベントの PoSW (本物) と hash を、起点から順に焼き直す。attacker が proof.json を丸ごと作り直す操作に相当する。
 * `tamperPosw` を指定すると、そのイベントの PoSW だけ書き換えたうえで `event.hash` 以降を再計算するので、
 * Hash mismatch ではなく PoSW の不一致だけが残る。
 */
async function rechainEvents(events: StoredEvent[], options: RechainOptions = {}): Promise<StoredEvent[]> {
  let previousHash = options.root ?? events[0]!.previousHash;
  const out: StoredEvent[] = [];
  for (const [i, original] of events.entries()) {
    const base = { ...original, previousHash };
    const poswInput = previousHash + deterministicStringify(pickHashedEventFields(base));
    const nonce = `fixed-nonce-${i}`;
    let posw: PoSWData = {
      iterations: POSW_ITERATIONS,
      nonce,
      intermediateHash: iterateSha256HexSync(poswInput + nonce, POSW_ITERATIONS),
      computeTimeMs: 1,
    };
    if (options.tamperPosw?.index === i) posw = options.tamperPosw.mutate(posw);
    const hash = await computeHash(previousHash + deterministicStringify({ ...pickHashedEventFields(base), posw }));
    out.push({ ...base, posw, hash });
    previousHash = hash;
  }
  return out;
}

/**
 * 焼き直したイベント列を proof.json に載せ直し、最終ハッシュと typingProofHash も整合させる。
 * `initialEventChainHash` (宣言された root) には触らない: ここを書き換えると root 式の再計算で別の理由で落ちる。
 */
async function resealProof(proof: ProofFileInput, events: StoredEvent[]): Promise<ProofFileInput> {
  const finalHash = events[events.length - 1]!.hash;
  const typingProofData = { ...proof.typingProofData, finalEventChainHash: finalHash };
  return {
    ...proof,
    typingProofHash: await computeHash(JSON.stringify(typingProofData)),
    typingProofData,
    proof: { ...proof.proof, events, finalHash },
    checkpoints: [],
  };
}

const DIFFERENT_ROOT = 'd'.repeat(64);

describe('verifyInitialHashRoot: root anchor vs first event previousHash (ADR-0017)', () => {
  it('accepts a proof whose first event starts from the declared initial chain hash', async () => {
    const proofFile = await buildProof();
    const result = await verifyInitialHashRoot(proofFile);
    expect(result.valid).toBe(true);
  });

  it('rejects a chain grafted onto a different root, even when the rest of the chain is re-hashed consistently', async () => {
    const proofFile = await buildProof();
    const declaredRoot = proofFile.typingProofData.initialEventChainHash;
    // 別セッションで記録したチェーンを接ぎ木した状況: 起点が宣言した root と違い、以降は整合している
    const grafted = await rechainEvents(proofFile.proof.events, { root: DIFFERENT_ROOT });
    expect(grafted[0]!.previousHash).toBe(DIFFERENT_ROOT);
    expect(grafted[0]!.previousHash).not.toBe(declaredRoot);
    const forged = await resealProof(proofFile, grafted);

    const result = await verifyInitialHashRoot(forged);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('First event does not start from the declared initial chain hash');
    expect(result.expectedInitialHash).toBe(declaredRoot);
    expect(result.computedInitialHash).toBe(DIFFERENT_ROOT);
  });

  it('makes verifyProofFile fail on the same graft (fast mode: the chain, final hash and typingProofHash are otherwise consistent)', async () => {
    const proofFile = await buildProof();
    const grafted = await rechainEvents(proofFile.proof.events, { root: DIFFERENT_ROOT });
    const forged = await resealProof(proofFile, grafted);

    // 前提の確認: root を縛る以外の層はこの改ざんを検出しない (= root 照合だけがこの接ぎ木を止める)
    const chain = await verifyChain(forged.proof.events, undefined, { skipPosw: true });
    expect(chain.valid).toBe(true);

    const result = await verifyProofFile(forged, undefined, { mode: 'fast' });

    expect(result.valid).toBe(false);
    expect(result.rootValid).toBe(false);
    expect(result.metadataValid).toBe(false);
    expect(result.errorMessage).toBe('First event does not start from the declared initial chain hash');
  });

  it('still accepts the same re-hashed chain when it is anchored at the declared root (positive control)', async () => {
    const proofFile = await buildProof();
    const declaredRoot = proofFile.typingProofData.initialEventChainHash!;
    const rechained = await rechainEvents(proofFile.proof.events, { root: declaredRoot });
    const resealed = await resealProof(proofFile, rechained);

    const result = await verifyProofFile(resealed, undefined, { mode: 'fast' });

    expect(result.valid).toBe(true);
    expect(result.rootValid).toBe(true);
  });
});

describe('verifyChain full mode: PoSW recompute', () => {
  it('accepts an untampered chain with real PoSW in full mode (positive control)', async () => {
    const proofFile = await buildProof(3);
    const events = await rechainEvents(proofFile.proof.events);

    const result = await verifyChain(events);

    expect(result.valid).toBe(true);
    expect(result.message).not.toMatch(/PoSW skipped/);
  });

  it('accepts an untampered proof through verifyProofFile in full mode (positive control)', async () => {
    const proofFile = await buildProof(3);
    const events = await rechainEvents(proofFile.proof.events);
    const resealed = await resealProof(proofFile, events);

    const result = await verifyProofFile(resealed, undefined, { mode: 'full' });

    expect(result.valid).toBe(true);
    expect(result.poswSkipped).toBe(false);
  });

  it.each([
    ['intermediateHash', (posw: PoSWData): PoSWData => ({ ...posw, intermediateHash: '0'.repeat(64) })],
    ['nonce', (posw: PoSWData): PoSWData => ({ ...posw, nonce: `${posw.nonce}-tampered` })],
  ])(
    'rejects a rewritten PoSW %s at the tampered event with a PoSW error, not a Hash mismatch',
    async (_field, mutate) => {
      const proofFile = await buildProof(3);
      const index = 1;
      // PoSW を書き換えたうえで、そのイベントの hash 以降を再計算する (Hash mismatch で落ちる余地を消す)
      const events = await rechainEvents(proofFile.proof.events, { tamperPosw: { index, mutate } });

      const result = await verifyChain(events);

      expect(result.valid).toBe(false);
      expect(result.errorAt).toBe(index);
      expect(result.message).toBe(`PoSW verification failed at event ${index}`);
      expect(result.message).not.toMatch(/Hash mismatch/);
    }
  );

  it('does not fail the same tampered chain when PoSW recompute is skipped (fast mode), which shows only the PoSW check catches it', async () => {
    const proofFile = await buildProof(3);
    const events = await rechainEvents(proofFile.proof.events, {
      tamperPosw: { index: 1, mutate: (posw) => ({ ...posw, intermediateHash: '0'.repeat(64) }) },
    });

    const result = await verifyChain(events, undefined, { skipPosw: true });

    expect(result.valid).toBe(true);
  });

  it('makes verifyProofFile fail in full mode on the same tampered chain, reporting the PoSW error and the event index', async () => {
    const proofFile = await buildProof(3);
    const events = await rechainEvents(proofFile.proof.events, {
      tamperPosw: { index: 2, mutate: (posw) => ({ ...posw, intermediateHash: '0'.repeat(64) }) },
    });
    const resealed = await resealProof(proofFile, events);

    const full = await verifyProofFile(resealed, undefined, { mode: 'full' });
    expect(full.valid).toBe(false);
    expect(full.chainValid).toBe(false);
    expect(full.errorAt).toBe(2);
    expect(full.errorMessage).toBe('PoSW verification failed at event 2');

    // fast モードは PoSW を再計算しないので、同じ proof を通してしまう (full との差が PoSW 検証そのもの)
    const fast = await verifyProofFile(resealed, undefined, { mode: 'fast' });
    expect(fast.valid).toBe(true);
  });
});
