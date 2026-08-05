/**
 * web ↔ CLI パリティテスト (#216)
 *
 * 同じ proof を「verify (web) の検証経路」と「verify-cli の検証経路」に通し、**結論が一致する**
 * ことを CI で固定する。2026-08-02 のレビューで見つかった重大な乖離は例外なく
 * 「shared に委譲していない箇所」に集中していた (#211) ので、文書ルールではなくテストで縛る。
 *
 * そろえる観点: 総合判定 (valid) / 三層保証 (integrity・temporal・provenance) / exam 束縛 /
 * スクリーンショット集計 (tampered・chainOnly)。正常系だけでなく **片方だけが落ちうるケース**
 * (別セッションのトークン流用・署名 cp のみ無効・スクショ改竄・スクショ剥ぎ取り) を含める。
 *
 * 注: スクショの **読込経路** (ZIP vs フォルダ) の一致は `screenshotParity.test.ts` (#212) が持つ。
 * ここが見るのは「同じ材料から web と CLI が同じ集計と同じ結論に至るか」(#213 の軸を含む)。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  TypingProof,
  checkScreenshotImage,
  collectChainImageHashes,
  computeHash,
  createSessionStartToken,
  deriveAssurance,
  sha256HexOfBytes,
  summarizeScreenshotArtifacts,
  type AssuranceResult,
  type CheckpointData,
  type ExamPackageManifest,
  type ExamSessionContext,
  type FingerprintComponents,
  type ScreenshotCaptureData,
  type ScreenshotVerificationSummary,
  type SessionStartToken,
} from '@typedcode/shared';
import {
  buildSignedCheckpoints,
  createTestKey,
  type TestKey,
} from '../../../../shared/src/__tests__/fixtures/signedCheckpointFixtures.js';
import { buildSamplePackage, makeExamAuthority } from '../../../../shared/src/__tests__/fixtures/examFixtures.js';
import { verifyProof } from '../../../../verify-cli/src/verify.js';
import { buildAssuranceInput, isOverallValid, runProofVerification } from '../proofVerification.js';
import { summarizeTabScreenshots } from '../screenshotSummary.js';
import type { ProofFile, VerifyScreenshot } from '../../types.js';

const SERVER_NONCE = 'a1'.repeat(32);
const ISSUED_AT = '2026-06-12T00:00:00.000Z';

/**
 * PoSW 用 Web Worker のスタブ (shared の `src/__tests__/setup.ts` と同じ役割)。
 * proof 生成時に `TypingProof` が Worker を起こすが Node 環境には存在しない。PoSW の
 * 反復再計算はどちらの経路でも `mode: 'fast'` でスキップするので、値は固定で構わない。
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
              nonce: 'stub-nonce',
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

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Parity Test)',
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

async function makeToken(key: TestKey, sessionId: string, fingerprintHash: string): Promise<SessionStartToken> {
  return createSessionStartToken(
    { sessionId, fingerprintHash },
    {
      serverNonce: SERVER_NONCE,
      issuedAt: ISSUED_AT,
      turnstileVerified: true,
      hostname: 'typedcode.dev',
      action: 'create_tab',
    },
    { keyId: key.keyId, privateKey: key.privateKey }
  );
}

async function typeInto(proof: TypingProof, text: string): Promise<string> {
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
  return content;
}

/**
 * root がサーバアンカーされ、署名 cp も付いた「健全な」proof を作る。
 * `tokenSessionId` と `checkpointSessionId` を別々に指定できるのは、別セッションのトークンを
 * 流用した proof (spec §6.3 が弾く) を再現するため。
 */
async function buildAnchoredProof(options: {
  key: TestKey;
  tokenSessionId: string;
  checkpointSessionId: string;
}): Promise<ProofFile> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await makeToken(options.key, options.tokenSessionId, fingerprintHash);

  const proof = new TypingProof();
  await proof.initializeAnchored(fingerprintHash, components, SERVER_NONCE, token);
  const content = await typeInto(proof, 'hello');
  const exported = await proof.exportProof(content);

  const checkpoints = await buildSignedCheckpoints({
    events: exported.proof.events,
    initialEventChainHash: exported.typingProofData.initialEventChainHash ?? '',
    key: options.key,
    sessionId: options.checkpointSessionId,
  });

  return { ...exported, checkpoints, content, language: 'text' } as ProofFile;
}

/** 署名 cp を持たない casual proof (exam ブロックは任意)。 */
async function buildPlainProof(examContext?: ExamSessionContext): Promise<ProofFile> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  if (examContext) {
    await proof.initializeExam(fingerprintHash, components, examContext);
  } else {
    await proof.initialize(fingerprintHash, components);
  }
  const content = await typeInto(proof, 'abc');
  const exported = await proof.exportProof(content);
  return { ...exported, content, language: 'text' } as ProofFile;
}

/**
 * チェーンに `screenshotCapture` (imageHash 付き) を 1 枚焼いた casual proof。
 * チェーンは改ざん不能なので、この imageHash がスクショの唯一の真正な記録になる。
 */
async function buildProofWithScreenshot(imageHash: string): Promise<ProofFile> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);
  const content = await typeInto(proof, 'ab');
  const capture: ScreenshotCaptureData = {
    imageHash,
    captureType: 'periodic',
    timestamp: 10,
    displayInfo: { width: 1440, height: 900, devicePixelRatio: 2 } as ScreenshotCaptureData['displayInfo'],
    storageKey: 'shot-0',
    fileSizeBytes: 24,
  };
  await proof.recordEvent({ type: 'screenshotCapture', data: capture });
  const exported = await proof.exportProof(content);
  return { ...exported, content, language: 'text' } as ProofFile;
}

/** manifest entry (CLI 入口) と VerifyScreenshot (web 入口) を同じ材料から作る。 */
async function buildScreenshotInputs(options: {
  proof: ProofFile;
  /** manifest が申告する imageHash。チェーンの値とずらすと「差し替え」になる。 */
  manifestImageHash: string;
  /** 実ファイルのバイト列。null なら欠損。 */
  bytes: Uint8Array | null;
}): Promise<{ web: ScreenshotVerificationSummary | undefined; cli: ScreenshotVerificationSummary }> {
  const { proof, manifestImageHash, bytes } = options;
  const chainImageHashes = collectChainImageHashes([proof.proof.events]);
  const entries = [{ filename: 'shot-0.webp', imageHash: manifestImageHash }];

  // CLI 入口: manifest entry + 画像バイト列 → shared がまとめて集計する。
  const cli = await summarizeScreenshotArtifacts({
    entries,
    getImageBytes: async () => bytes,
    chainImageHashes,
  });

  // web 入口: 読込時に per-image 判定 (ScreenshotService と同じ shared の checkScreenshotImage)
  // を済ませた VerifyScreenshot を per-tab 集計にかける。
  const check = bytes ? await checkScreenshotImage(bytes, manifestImageHash, chainImageHashes) : null;
  const screenshots: VerifyScreenshot[] = [
    {
      imageHash: manifestImageHash,
      verified: check?.verified ?? false,
      tampered: check?.tampered ?? false,
      missing: bytes === null,
    } as unknown as VerifyScreenshot,
  ];
  const web = summarizeTabScreenshots({ screenshots, events: proof.proof.events });
  return { web, cli };
}

/** 架空の束縛値で exam root を自己整合させた proof (束縛は package を当てれば必ず落ちる)。 */
const forgedExamContext = (): ExamSessionContext => ({
  examId: 'exam-1',
  problemId: 'p1',
  variant: null,
  packageHash: 'f'.repeat(64),
  problemContentHash: 'e'.repeat(64),
  startToken: 'ABCD1234',
});

interface ParityConclusion {
  valid: boolean;
  assurance: AssuranceResult;
  exam: { present: boolean; packageProvided: boolean; bindingValid?: boolean } | null;
}

interface ConclusionOptions {
  manifest?: ExamPackageManifest;
  /**
   * スクリーンショット集計。`undefined` = 未検査 (proof.json 単体) で、どちらの経路でも
   * 判定に影響させない。web は `summarizeTabScreenshots`、CLI は `summarizeScreenshotArtifacts`
   * が作る同じ型 (shared の `ScreenshotVerificationSummary`)。
   */
  screenshots?: ScreenshotVerificationSummary;
}

/** verify (web) の経路: Worker が使う合成 → UI (TabController / VerificationController) の総合判定と三層保証。 */
async function webConclusion(
  proof: ProofFile,
  registry: readonly TestKey['registryEntry'][],
  options: ConclusionOptions = {}
): Promise<ParityConclusion> {
  const result = await runProofVerification(proof, {
    mode: 'fast',
    manifest: options.manifest,
    signedCheckpointKeyRegistry: registry,
  });
  const screenshotsTampered = options.screenshots?.tampered;
  return {
    valid: isOverallValid(result, { screenshotsTampered }),
    assurance: deriveAssurance(buildAssuranceInput(result, { screenshotsTampered })),
    exam: result.exam
      ? {
          present: result.exam.present,
          packageProvided: result.exam.packageProvided,
          bindingValid: result.exam.binding?.valid,
        }
      : null,
  };
}

/** verify-cli の経路: CLI 本体の verifyProof をそのまま呼ぶ。 */
async function cliConclusion(
  proof: ProofFile,
  registry: readonly TestKey['registryEntry'][],
  options: ConclusionOptions = {}
): Promise<ParityConclusion> {
  const result = await verifyProof(proof, {
    mode: 'fast',
    examPackageManifest: options.manifest,
    signedCheckpointKeyRegistry: registry,
    screenshotSummary: options.screenshots,
  });
  return {
    valid: result.valid,
    assurance: result.assurance,
    exam: result.exam
      ? {
          present: result.exam.present,
          packageProvided: result.exam.packageProvided,
          bindingValid: result.exam.binding?.valid,
        }
      : null,
  };
}

/** 分析層 (ADR-0009) は advisory なので比較対象は integrity / temporal と pureTyping に絞る。 */
function comparableAssurance(a: AssuranceResult) {
  return { integrity: a.integrity, temporal: a.temporal, pureTyping: a.provenance.pureTyping };
}

function expectSameConclusion(web: ParityConclusion, cli: ParityConclusion): void {
  expect(web.valid).toBe(cli.valid);
  expect(comparableAssurance(web.assurance)).toEqual(comparableAssurance(cli.assurance));
  expect(web.exam).toEqual(cli.exam);
}

let testKey: TestKey;
let registry: readonly TestKey['registryEntry'][];

beforeAll(async () => {
  testKey = await createTestKey();
  registry = [testKey.registryEntry];
});

describe('web ↔ CLI parity (#216)', () => {
  it('agrees that a healthy anchored proof is valid and fully anchored', async () => {
    const proof = await buildAnchoredProof({
      key: testKey,
      tokenSessionId: 'session-A',
      checkpointSessionId: 'session-A',
    });

    const web = await webConclusion(proof, registry);
    const cli = await cliConclusion(proof, registry);

    expectSameConclusion(web, cli);
    expect(web.valid).toBe(true);
    expect(web.assurance.integrity).toBe('proven');
    expect(web.assurance.temporal).toBe('anchored');
  });

  it('agrees that a proof reusing another session token is invalid (spec §6.3)', async () => {
    // 別セッションで発行されたトークンを流用: root は自己整合するが署名 cp の sessionId と食い違う。
    const proof = await buildAnchoredProof({
      key: testKey,
      tokenSessionId: 'session-B',
      checkpointSessionId: 'session-A',
    });

    const web = await webConclusion(proof, registry);
    const cli = await cliConclusion(proof, registry);

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(false);
    // 暗号的な改ざんはないので「整合性」は proven のまま — 誤って改ざん告発しない。
    expect(cli.assurance.integrity).toBe('proven');
  });

  it('agrees that a proof whose signed checkpoint is invalid keeps integrity proven but fails overall', async () => {
    const proof = await buildAnchoredProof({
      key: testKey,
      tokenSessionId: 'session-A',
      checkpointSessionId: 'session-A',
    });
    // 署名だけを壊す (チェーン・メタデータ・content は無傷)。
    const checkpoints = (proof.checkpoints ?? []).map((cp, index): CheckpointData => {
      if (index !== 0 || !cp.signature) return cp;
      const signature = cp.signature.signature;
      const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
      return { ...cp, signature: { ...cp.signature, signature: flipped } };
    });
    const tampered: ProofFile = { ...proof, checkpoints };

    const web = await webConclusion(tampered, registry);
    const cli = await cliConclusion(tampered, registry);

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(false);
    // ADR-0020 の三層: 落ちたのは時刻アンカー層であって整合性ではない。
    expect(cli.assurance.integrity).toBe('proven');
    expect(cli.assurance.temporal).toBe('partial');
  });

  it('agrees that a tampered hash chain fails integrity', async () => {
    const proof = await buildAnchoredProof({
      key: testKey,
      tokenSessionId: 'session-A',
      checkpointSessionId: 'session-A',
    });
    const events = proof.proof.events.map((event, index) => (index === 1 ? { ...event, data: 'X' } : event));
    const tampered: ProofFile = { ...proof, proof: { ...proof.proof, events } };

    const web = await webConclusion(tampered, registry);
    const cli = await cliConclusion(tampered, registry);

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(false);
    expect(cli.assurance.integrity).toBe('failed');
  });

  it('agrees on an unanchored casual proof (no signed checkpoints)', async () => {
    const proof = await buildPlainProof();

    const web = await webConclusion(proof, registry);
    const cli = await cliConclusion(proof, registry);

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(true);
    expect(cli.assurance.temporal).toBe('unanchored');
  });

  it('agrees on an exam proof whose package was not provided (binding unverified)', async () => {
    const proof = await buildPlainProof(forgedExamContext());

    const web = await webConclusion(proof, registry);
    const cli = await cliConclusion(proof, registry);

    expectSameConclusion(web, cli);
    expect(cli.exam).toEqual({ present: true, packageProvided: false, bindingValid: undefined });
    // 自己申告の exam ブロックだけでは exam-t0 を名乗れない (#131 / ADR-0020)。
    expect(cli.assurance.temporal).not.toBe('exam-t0');
  });

  it('agrees that a provided exam package failing binding invalidates the proof', async () => {
    const authority = await makeExamAuthority();
    // registry (本番の出題者鍵) に載っていないテスト鍵で署名した package → 束縛は必ず落ちる。
    const { manifest } = await buildSamplePackage(authority.signer);
    const proof = await buildPlainProof(forgedExamContext());

    const web = await webConclusion(proof, registry, { manifest });
    const cli = await cliConclusion(proof, registry, { manifest });

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(false);
    expect(cli.exam?.bindingValid).toBe(false);
    expect(cli.assurance.integrity).toBe('failed');
  });

  it('agrees on a healthy screenshot (chain-backed image, no issue)', async () => {
    const bytes = new TextEncoder().encode('genuine-screenshot-bytes');
    const imageHash = await sha256HexOfBytes(bytes);
    const proof = await buildProofWithScreenshot(imageHash);

    const summaries = await buildScreenshotInputs({ proof, manifestImageHash: imageHash, bytes });
    expect(summaries.web).toEqual(summaries.cli);
    expect(summaries.cli).toMatchObject({ total: 1, verified: 1, tampered: 0, chainOnly: 0 });

    const web = await webConclusion(proof, registry, { screenshots: summaries.web });
    const cli = await cliConclusion(proof, registry, { screenshots: summaries.cli });

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(true);
    expect(cli.assurance.integrity).toBe('proven');
  });

  it('agrees that a screenshot swapped together with its manifest hash fails integrity (#212)', async () => {
    // manifest と画像をセットで差し替えた提出物。画像の SHA-256 は manifest と一致する
    // (verified) が、チェーンに焼かれた imageHash には無い → 改竄。
    const chainBytes = new TextEncoder().encode('genuine-screenshot-bytes');
    const chainImageHash = await sha256HexOfBytes(chainBytes);
    const swappedBytes = new TextEncoder().encode('swapped-screenshot-bytes');
    const swappedImageHash = await sha256HexOfBytes(swappedBytes);
    const proof = await buildProofWithScreenshot(chainImageHash);

    const summaries = await buildScreenshotInputs({
      proof,
      manifestImageHash: swappedImageHash,
      bytes: swappedBytes,
    });
    expect(summaries.web).toEqual(summaries.cli);
    // 差し替えた 1 枚は tampered、チェーン側の 1 枚は manifest に無いので chainOnly。
    expect(summaries.cli).toMatchObject({ tampered: 1, chainOnly: 1 });

    const web = await webConclusion(proof, registry, { screenshots: summaries.web });
    const cli = await cliConclusion(proof, registry, { screenshots: summaries.cli });

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(false);
    // スクショ改竄は整合性 (error 軸) — チェーン自体は無傷でも proof 全体を落とす。
    expect(cli.assurance.integrity).toBe('failed');
  });

  it('agrees that stripped screenshots are a warning, not an integrity failure (#213)', async () => {
    // `screenshots/` を丸ごと落とした提出物: manifest entry は 0 だが、チェーンには記録が残る。
    const bytes = new TextEncoder().encode('genuine-screenshot-bytes');
    const imageHash = await sha256HexOfBytes(bytes);
    const proof = await buildProofWithScreenshot(imageHash);
    const chainImageHashes = collectChainImageHashes([proof.proof.events]);

    const cliSummary = await summarizeScreenshotArtifacts({
      entries: [],
      getImageBytes: async () => null,
      chainImageHashes,
    });
    const webSummary = summarizeTabScreenshots({ screenshots: [], events: proof.proof.events });
    expect(webSummary).toEqual(cliSummary);
    expect(cliSummary).toMatchObject({ total: 0, tampered: 0, chainOnly: 1 });

    const web = await webConclusion(proof, registry, { screenshots: webSummary });
    const cli = await cliConclusion(proof, registry, { screenshots: cliSummary });

    expectSameConclusion(web, cli);
    // 剥ぎ取りは warning 軸 (exit code / valid には干渉しない)。誤って改ざん告発しないこと。
    expect(cli.valid).toBe(true);
    expect(cli.assurance.integrity).toBe('proven');
  });

  it('agrees that screenshots are simply not checked for a bare proof.json', async () => {
    const bytes = new TextEncoder().encode('genuine-screenshot-bytes');
    const imageHash = await sha256HexOfBytes(bytes);
    const proof = await buildProofWithScreenshot(imageHash);

    // proof.json 単体投入 = 検査対象が無い。「0 枚」と混同すると剥ぎ取り扱いになって誤検知。
    const webSummary = summarizeTabScreenshots({ screenshots: undefined, events: proof.proof.events });
    expect(webSummary).toBeUndefined();

    const web = await webConclusion(proof, registry, { screenshots: webSummary });
    const cli = await cliConclusion(proof, registry, { screenshots: undefined });

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(true);
    expect(cli.assurance.integrity).toBe('proven');
  });
});
