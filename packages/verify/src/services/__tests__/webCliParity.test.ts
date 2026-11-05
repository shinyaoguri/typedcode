/**
 * web ↔ CLI パリティテスト (#216)
 *
 * 同じ proof を「verify (web) の検証経路」と「verify-cli の検証経路」に通し、**結論が一致する**
 * ことを CI で固定する。2026-08-02 のレビューで見つかった重大な乖離は例外なく
 * 「shared に委譲していない箇所」に集中していた (#211) ので、文書ルールではなくテストで縛る。
 *
 * そろえる観点: 総合判定 (valid) / 三層保証 (integrity・temporal・provenance) / exam 束縛 /
 * スクリーンショット集計 (tampered・chainOnly) / **検証モード (fast の PoSW 未再計算, #214)**。
 * 正常系だけでなく **片方だけが落ちうるケース**
 * (別セッションのトークン流用・署名 cp のみ無効・スクショ改竄・スクショ剥ぎ取り) を含める。
 *
 * 既定の経路は `mode: 'fast'` (PoSW 再計算は Worker スタブの都合で回せない) なので、
 * このファイルの整合性期待値は原則 `partial` になる。`proven` / `partial` の分岐そのものは
 * 「fast と full で結論が変わる」ケース (末尾) が実 PoSW を計算して固定する。
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
  type ProofVersionStatus,
  type ScreenshotVerificationSummary,
  type SessionStartToken,
  type VerificationMode,
} from '@typedcode/shared';
import {
  buildSignedCheckpoints,
  createTestKey,
  type TestKey,
} from '../../../../shared/src/__tests__/fixtures/signedCheckpointFixtures.js';
import { buildSamplePackage, makeExamAuthority } from '../../../../shared/src/__tests__/fixtures/examFixtures.js';
import { verifyProof } from '../../../../verify-cli/src/verify.js';
import { formatResult } from '../../../../verify-cli/src/output.js';
import { TrustCalculator } from '../TrustCalculator.js';
import { buildAssuranceInput, isOverallValid, runProofVerification } from '../proofVerification.js';
import { summarizeTabScreenshots } from '../screenshotSummary.js';
import type { ProofFile, VerifyScreenshot } from '../../types.js';

const SERVER_NONCE = 'a1'.repeat(32);
// 署名 cp (fixture の既定は 2026-05-28T12:00:01Z から 1 秒間隔) より前。token の後に root を作り、その後に
// 打鍵・署名するので、issuedAt が cp の serverTimestamp より後だと post-hoc の照合の基点で矛盾する (#320)。
const ISSUED_AT = '2026-05-28T12:00:00.000Z';

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

/**
 * PoSW を**本当に**計算するスタブ (`poswWorker.ts` と同じ手順)。full モードで検証が通る proof を
 * 作るために必要 — 上の固定値スタブでは `verifyPoSW` の再計算と必ず食い違う。
 * 1 イベントあたり 10,000 回の SHA-256 を回すので、使うのは #214 のモード分岐テストだけ。
 */
class RealPoswWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: Record<string, unknown>): void {
    void (async () => {
      if (!this.onmessage) return;
      if (message.type !== 'compute-posw') {
        this.onmessage({ data: { type: 'verify-result', requestId: message.requestId, valid: true } } as MessageEvent);
        return;
      }
      const iterations = message.iterations as number;
      const nonce = 'ab'.repeat(16);
      let hash = await computeHash(`${message.previousHash as string}${message.eventDataString as string}${nonce}`);
      for (let i = 1; i < iterations; i++) {
        hash = await computeHash(hash);
      }
      this.onmessage({
        data: {
          type: 'posw-result',
          requestId: message.requestId,
          iterations,
          nonce,
          intermediateHash: hash,
          computeTimeMs: 1,
        },
      } as MessageEvent);
    })();
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
  /** token を発行する鍵。省略時は `key` (署名 cp と同じ鍵)。registry に無い鍵を渡すと #329 の状況になる。 */
  tokenKey?: TestKey;
  tokenSessionId: string;
  checkpointSessionId: string;
  /** 署名 cp を打つ eventIndex。省略時は全イベント (最終イベントまで署名が届く正常形)。 */
  signedEventIndexes?: number[];
  /** 指定すると、打鍵の後にこの signature の export 前 attestation を記録してから export する (#415)。 */
  preExportSignature?: string;
}): Promise<ProofFile> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const token = await makeToken(options.tokenKey ?? options.key, options.tokenSessionId, fingerprintHash);

  const proof = new TypingProof();
  await proof.initializeAnchored(fingerprintHash, components, SERVER_NONCE, token);
  const content = await typeInto(proof, 'hello');
  if (options.preExportSignature !== undefined) {
    await proof.recordPreExportAttestation({
      success: true,
      verified: true,
      score: 1,
      action: 'export_proof',
      timestamp: ISSUED_AT,
      hostname: 'typedcode.dev',
      signature: options.preExportSignature,
    });
  }
  const exported = await proof.exportProof(content);

  const checkpoints = await buildSignedCheckpoints({
    events: exported.proof.events,
    initialEventChainHash: exported.typingProofData.initialEventChainHash ?? '',
    key: options.key,
    sessionId: options.checkpointSessionId,
    eventIndexes: options.signedEventIndexes,
  });

  return { ...exported, checkpoints, content, language: 'text' } as ProofFile;
}

/**
 * proof の署名 cp を差し替える (受理ポリシーのパリティ #296 用)。`signedEventIndexes` が空なら署名 cp なし。
 * `serverStepMs` を 60 秒にすると、署名は健全なまま密度だけが疎になる (閾値 50 秒)。
 */
async function withSignedCheckpoints(
  proof: ProofFile,
  options: { key: TestKey; sessionId: string; signedEventIndexes?: number[]; serverStepMs?: number }
): Promise<ProofFile> {
  const checkpoints =
    options.signedEventIndexes?.length === 0
      ? []
      : await buildSignedCheckpoints({
          events: proof.proof.events,
          initialEventChainHash: proof.typingProofData.initialEventChainHash ?? '',
          key: options.key,
          sessionId: options.sessionId,
          eventIndexes: options.signedEventIndexes,
          serverStepMs: options.serverStepMs,
        });
  return { ...proof, checkpoints } as ProofFile;
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
  /**
   * proof.version のゲート (#223)。`status` は shared の分類、`warns` は「検証器より新しい」warning を
   * 出したか (web は TrustCalculator の issue、CLI は formatResult の行)、`errorMentionsVersion` は
   * 不合格の理由に version が出たか。
   */
  version: { status: ProofVersionStatus | undefined; warns: boolean; errorMentionsVersion: boolean };
}

interface ConclusionOptions {
  manifest?: ExamPackageManifest;
  /**
   * スクリーンショット集計。`undefined` = 未検査 (proof.json 単体) で、どちらの経路でも
   * 判定に影響させない。web は `summarizeTabScreenshots`、CLI は `summarizeScreenshotArtifacts`
   * が作る同じ型 (shared の `ScreenshotVerificationSummary`)。
   */
  screenshots?: ScreenshotVerificationSummary;
  /** 検証モード (#214)。既定は `fast` (PoSW 再計算はスタブ Worker では回せないため)。 */
  mode?: VerificationMode;
}

/** verify (web) の経路: Worker が使う合成 → UI (TabController / VerificationController) の総合判定と三層保証。 */
async function webConclusion(
  proof: ProofFile,
  registry: readonly TestKey['registryEntry'][],
  options: ConclusionOptions = {}
): Promise<ParityConclusion> {
  const result = await runProofVerification(proof, {
    mode: options.mode ?? 'fast',
    manifest: options.manifest,
    signedCheckpointKeyRegistry: registry,
  });
  const screenshotsTampered = options.screenshots?.tampered;
  const trust = TrustCalculator.calculate(result, undefined);
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
    version: {
      status: result.versionStatus,
      warns: trust.issues.some((i) => i.component === 'version' && i.severity === 'warning'),
      errorMentionsVersion: /version/i.test(result.message ?? ''),
    },
  };
}

/** verify-cli の経路: CLI 本体の verifyProof をそのまま呼ぶ。 */
async function cliConclusion(
  proof: ProofFile,
  registry: readonly TestKey['registryEntry'][],
  options: ConclusionOptions = {}
): Promise<ParityConclusion> {
  const result = await verifyProof(proof, {
    mode: options.mode ?? 'fast',
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
    version: {
      status: result.versionStatus,
      // 色は TTY 依存で付くので、警告文の本体だけを見る (ANSI の有無に左右されない)。
      warns: formatResult(result).includes('newer than this verifier supports'),
      errorMentionsVersion: /version/i.test(result.errorMessage ?? ''),
    },
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
  expect(web.version).toEqual(cli.version);
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
    // fast 経路なので整合性は proven ではなく partial (#214)。両経路が同じ語彙を出すことが要。
    expect(web.assurance.integrity).toBe('partial');
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
    // 暗号的な改ざんはないので「整合性」は failed にしない — 誤って改ざん告発しない
    // (fast 経路なので proven ではなく partial)。
    expect(cli.assurance.integrity).toBe('partial');
    // 別セッションの署名 cp はこの proof の時刻証拠にならない (#295 / #329 後半)。root のアンカーだけが残る。
    expect(web.assurance.temporal).toBe('partial');
    expect(cli.assurance.temporal).toBe('partial');
  });

  describe('a session start token signed by a key outside the registry (#329)', () => {
    // 古い registry を同梱した検証器で新しい鍵の token を見る状況。root は serverNonce 込みで自己整合する。
    it('agrees that the proof fails overall without failing integrity, and is unanchored without signed checkpoints', async () => {
      const proof = await buildAnchoredProof({
        key: testKey,
        tokenKey: await createTestKey(),
        tokenSessionId: 'session-A',
        checkpointSessionId: 'session-A',
        signedEventIndexes: [],
      });

      const web = await webConclusion(proof, registry);
      const cli = await cliConclusion(proof, registry);

      expectSameConclusion(web, cli);
      expect(cli.valid).toBe(false);
      // 改ざんではない (fast 経路なので proven ではなく partial)。
      expect(cli.assurance.integrity).toBe('partial');
      expect(cli.assurance.temporal).toBe('unanchored');
    });

    it('agrees that trusted signed checkpoints make the timeline partial, never anchored', async () => {
      const proof = await buildAnchoredProof({
        key: testKey,
        tokenKey: await createTestKey(),
        tokenSessionId: 'session-A',
        checkpointSessionId: 'session-A',
      });

      const web = await webConclusion(proof, registry);
      const cli = await cliConclusion(proof, registry);

      expectSameConclusion(web, cli);
      expect(cli.valid).toBe(false);
      expect(cli.assurance.integrity).toBe('partial');
      expect(cli.assurance.temporal).toBe('partial');
    });

    it('reports it as an anchoring error on the web and as an untrusted root anchor in the CLI, not as tampering', async () => {
      const proof = await buildAnchoredProof({
        key: testKey,
        tokenKey: await createTestKey(),
        tokenSessionId: 'session-A',
        checkpointSessionId: 'session-A',
      });

      const webResult = await runProofVerification(proof, { mode: 'fast', signedCheckpointKeyRegistry: registry });
      const trust = TrustCalculator.calculate(webResult, undefined);
      const cliText = formatResult(
        await verifyProof(proof, { mode: 'fast', signedCheckpointKeyRegistry: registry })
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの除去そのものが目的
      ).replace(/\x1b\[[0-9;]*m/g, '');

      expect(trust.issues.some((i) => i.component === 'anchoring' && i.severity === 'error')).toBe(true);
      expect(trust.issues.some((i) => i.component === 'metadata' || i.component === 'chain')).toBe(false);
      expect(cliText).toMatch(/^Root anchor: UNTRUSTED /m);
      expect(cliText).toMatch(/^Metadata: {4}PASS$/m);
    });
  });

  it('reaches the same conclusion for a legacy HMAC pre-export signature and an unsigned one (#415)', async () => {
    // 旧 Worker が返した HMAC 値 (64 hex) を持つ旧 proof と、#415 以降の 'unsigned' の proof。
    // 検証器は signature を読まないので、web / CLI とも、2 本の結論が同じでなければならない。
    const build = (preExportSignature: string) =>
      buildAnchoredProof({
        key: testKey,
        tokenSessionId: 'session-A',
        checkpointSessionId: 'session-A',
        preExportSignature,
      });
    const legacy = await build('3f'.repeat(32));
    const unsigned = await build('unsigned');
    expect(legacy.proof.events.some((e) => e.type === 'preExportAttestation')).toBe(true);

    const legacyWeb = await webConclusion(legacy, registry);
    const legacyCli = await cliConclusion(legacy, registry);
    const unsignedWeb = await webConclusion(unsigned, registry);
    const unsignedCli = await cliConclusion(unsigned, registry);

    expectSameConclusion(legacyWeb, legacyCli);
    expectSameConclusion(unsignedWeb, unsignedCli);
    expectSameConclusion(legacyCli, unsignedCli);
    expect(unsignedCli.valid).toBe(true);
    expect(unsignedCli.assurance.temporal).toBe('anchored');
  });

  it('agrees that a proof whose last events are not signed is only partially anchored (#295)', async () => {
    // 先頭イベントだけ署名し、以降を署名なしで書き足した proof。密度は疎にならず post-hoc も立たない。
    const proof = await buildAnchoredProof({
      key: testKey,
      tokenSessionId: 'session-A',
      checkpointSessionId: 'session-A',
      signedEventIndexes: [0],
    });

    const web = await webConclusion(proof, registry);
    const cli = await cliConclusion(proof, registry);

    expectSameConclusion(web, cli);
    // valid の判定は変えない (最終署名を受理条件にするのは #296)。
    expect(cli.valid).toBe(true);
    // 片側の写像だけ直すと、ここか expectSameConclusion のどちらかが赤になる。
    expect(web.assurance.temporal).toBe('partial');
    expect(cli.assurance.temporal).toBe('partial');
  });

  it('agrees that a proof whose signed checkpoint is invalid does not fail integrity but fails overall', async () => {
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
    // ADR-0020 の三層: 落ちたのは時刻アンカー層であって整合性ではない (整合性は failed にしない)。
    expect(cli.assurance.integrity).not.toBe('failed');
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

  it('agrees that a package provided for a proof with no exam block invalidates it (#218)', async () => {
    const authority = await makeExamAuthority();
    const { manifest } = await buildSamplePackage(authority.signer);
    // casual proof (exam ブロック無し) に問題パッケージを渡した = 採点ゲートの誤用。
    // 黙って exit 0 にすると ADR-0006 の保証が丸ごと欠落したまま「合格」で通る (#218)。
    const proof = await buildPlainProof();

    const web = await webConclusion(proof, registry, { manifest });
    const cli = await cliConclusion(proof, registry, { manifest });

    expectSameConclusion(web, cli);
    expect(cli.valid).toBe(false);
    expect(cli.exam).toEqual({ present: false, packageProvided: true, bindingValid: false });
    // gate の無効化であって改ざんではない (ADR-0020 の語彙)。integrity は落とさない。
    expect(cli.assurance.integrity).toBe('partial');
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
    expect(cli.assurance.integrity).not.toBe('failed');
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
    expect(cli.assurance.integrity).not.toBe('failed');
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
    expect(cli.assurance.integrity).not.toBe('failed');
  });

  // #223: proof.version のゲート。version は typingProofHash の入力ではないので、名乗り替えても
  // 他の検査は無傷 — 結論の差は version だけから生じる。
  describe('proof version gate (#223)', () => {
    it('agrees that a current-version proof raises no version warning', async () => {
      const proof = await buildPlainProof();

      const web = await webConclusion(proof, registry);
      const cli = await cliConclusion(proof, registry);

      expectSameConclusion(web, cli);
      expect(cli.valid).toBe(true);
      expect(cli.version).toEqual({ status: 'current', warns: false, errorMentionsVersion: false });
    });

    it('agrees that a newer-major proof stays valid but warns on both paths', async () => {
      const proof = { ...(await buildPlainProof()), version: '2.0.0' } as ProofFile;

      const web = await webConclusion(proof, registry);
      const cli = await cliConclusion(proof, registry);

      expectSameConclusion(web, cli);
      expect(cli.valid).toBe(true);
      expect(cli.version).toEqual({ status: 'newer', warns: true, errorMentionsVersion: false });
    });

    it.each([
      ['below the minimum supported version', '0.9.0', 'tooOld'],
      ['not MAJOR.MINOR.PATCH', '1.2.0-beta', 'malformed'],
      ['missing', undefined, 'malformed'],
    ] as const)(
      'agrees that a proof whose version is %s is rejected with a version reason',
      async (_label, version, status) => {
        const base = await buildPlainProof();
        const proof = { ...base, version } as ProofFile;

        const web = await webConclusion(proof, registry);
        const cli = await cliConclusion(proof, registry);

        expectSameConclusion(web, cli);
        expect(cli.valid).toBe(false);
        expect(cli.version).toEqual({ status, warns: false, errorMentionsVersion: true });
        // 整合性 (改ざん耐性) の主張は version では変わらない — 改ざん告発に化けさせない。
        expect(cli.assurance.integrity).not.toBe('failed');
      }
    );
  });

  /**
   * #214: fast モードは PoSW の反復再計算をスキップする (spec §8.2)。web も CLI も
   * 「整合性: 証明済み」を名乗ってはならず、**同じ語彙**に落ちること。full では従来どおり proven。
   * ここだけ実 PoSW を計算するので、他ケースより時間がかかる。
   */
  it('agrees that fast mode does not prove integrity while full mode does', async () => {
    vi.stubGlobal('Worker', RealPoswWorkerStub);
    let proof: ProofFile;
    try {
      proof = await buildPlainProof();
    } finally {
      vi.stubGlobal('Worker', PoswWorkerStub);
    }

    const fastWeb = await webConclusion(proof, registry, { mode: 'fast' });
    const fastCli = await cliConclusion(proof, registry, { mode: 'fast' });
    expectSameConclusion(fastWeb, fastCli);
    // fast は「速い改ざん検出」として正当。valid は落とさないが、整合性は proven を名乗らない。
    expect(fastCli.valid).toBe(true);
    expect(fastCli.assurance.integrity).toBe('partial');

    const fullWeb = await webConclusion(proof, registry, { mode: 'full' });
    const fullCli = await cliConclusion(proof, registry, { mode: 'full' });
    expectSameConclusion(fullWeb, fullCli);
    expect(fullCli.valid).toBe(true);
    expect(fullCli.assurance.integrity).toBe('proven');
  }, 60_000);

  /**
   * 受理ポリシー (#296): Web はポリシーを適用せず、署名 cp の有無・最終署名・未署名の末尾を表示するだけ。
   * CLI の違反はその表示と同じ shared の coverage から来ることを、6 つの証拠の形で固定する。
   */
  describe('acceptance policy parity (#296)', () => {
    const anchored = (signedEventIndexes?: number[], serverStepMs?: number) => async () =>
      withSignedCheckpoints(
        await buildAnchoredProof({ key: testKey, tokenSessionId: 'session-A', checkpointSessionId: 'session-A' }),
        { key: testKey, sessionId: 'session-A', signedEventIndexes, serverStepMs }
      );
    const unanchored = (signedEventIndexes?: number[]) => async () =>
      withSignedCheckpoints(await buildPlainProof(), { key: testKey, sessionId: 'session-A', signedEventIndexes });

    const CASES: ReadonlyArray<readonly [string, () => Promise<ProofFile>]> = [
      ['root anchor only', anchored([])],
      ['signed checkpoints only', unanchored()],
      ['no signed checkpoints', unanchored([])],
      ['sparse anchoring', anchored(undefined, 60_000)],
      ['final event signed', anchored()],
      ['final events unsigned', anchored([0])],
    ];

    /** 6 ケースが本当に別の形になっていること (パリティの比較が全部同じ値どうしにならないこと) の前提。 */
    const EXPECTED_STRICT_CODES: Record<string, string[]> = {
      'root anchor only': ['signed-checkpoints-missing', 'terminal-anchor-missing'],
      'signed checkpoints only': [],
      'no signed checkpoints': ['signed-checkpoints-missing', 'terminal-anchor-missing'],
      'sparse anchoring': [],
      'final event signed': [],
      'final events unsigned': ['terminal-anchor-missing'],
    };

    async function bothPaths(build: () => Promise<ProofFile>) {
      const proof = await build();
      const web = await runProofVerification(proof, { mode: 'fast', signedCheckpointKeyRegistry: registry });
      const cliPlain = await verifyProof(proof, { mode: 'fast', signedCheckpointKeyRegistry: registry });
      const cliStrict = await verifyProof(proof, {
        mode: 'fast',
        signedCheckpointKeyRegistry: registry,
        requireSignedCheckpoints: true,
        requireTerminalAnchor: true,
      });
      return { web, cliPlain, cliStrict };
    }

    it.each(CASES)(
      'reports the same signed checkpoint coverage on the web and in the CLI for "%s"',
      async (_label, build) => {
        const { web, cliPlain } = await bothPaths(build);
        const pick = (c: { signedCount: number; terminalAnchored: boolean; unsignedTailEvents: number } | undefined) =>
          c && {
            signedCount: c.signedCount,
            terminalAnchored: c.terminalAnchored,
            unsignedTailEvents: c.unsignedTailEvents,
          };

        expect(pick(web.signedCheckpointCoverage)).toEqual(pick(cliPlain.signedCheckpoints?.coverage));
      }
    );

    it.each(CASES)('derives the CLI violations from what the web shows for "%s"', async (_label, build) => {
      const { web, cliStrict } = await bothPaths(build);
      const coverage = web.signedCheckpointCoverage!;
      const codes = cliStrict.policy.violations.map((v) => v.code);
      const terminal = cliStrict.policy.violations.find((v) => v.code === 'terminal-anchor-missing');

      expect(cliStrict.policy.evaluated).toBe(true);
      expect(codes.includes('signed-checkpoints-missing')).toBe(coverage.signedCount === 0);
      expect(terminal?.unsignedTailEvents).toBe(
        !coverage.terminalAnchored && coverage.unsignedTailEvents > 0 ? coverage.unsignedTailEvents : undefined
      );
    });

    it.each(CASES)(
      'fails the CLI with the expected violations under the strict policy for "%s"',
      async (label, build) => {
        const { cliStrict } = await bothPaths(build);

        expect(cliStrict.policy.violations.map((v) => v.code)).toEqual(EXPECTED_STRICT_CODES[label]);
        expect(cliStrict.valid).toBe(EXPECTED_STRICT_CODES[label]!.length === 0);
      }
    );

    it.each(CASES)(
      'keeps the web verdict equal to the CLI verdict without a policy for "%s"',
      async (_label, build) => {
        const { web, cliPlain } = await bothPaths(build);

        expect(web.valid).toBe(cliPlain.valid);
        expect(cliPlain.policy.violations).toEqual([]);
      }
    );
  });
});
