/**
 * 受理ポリシー (#296 / ADR-0043) を固定する。
 *
 * - 純関数 `evaluateAcceptancePolicy` の表テスト: 6 つの証拠の形 (root のみ / 署名 cp のみ / 署名 cp 0 件 /
 *   密度不足 / 最終イベントまで署名 / 末尾が未署名) × 4 要件で、どの違反が出るかを一覧で縛る
 * - `verifyProofFile` 経由: 実鍵・実 root・署名位置を選べる proof を作り、`integrityValid` / `policy` /
 *   `valid` / `errorMessage` の組み立てを見る。改ざん proof ではポリシーを評価しない (`evaluated: false`)
 *
 * MockWorker が PoSW を偽データで返すので `mode: 'fast'` で検証する (`assurance.unsignedTail.test.ts` と同じ)。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  ANCHOR_DENSITY_SPARSE_MESSAGE,
  EXAM_ROOT_ANCHOR_REQUIRED_MESSAGE,
  ROOT_ANCHOR_REQUIRED_MESSAGE,
  SIGNED_CHECKPOINTS_MISSING_MESSAGE,
  TERMINAL_ANCHOR_MISSING_MESSAGE,
  TypingProof,
  computeHash,
  createSessionStartToken,
  evaluateAcceptancePolicy,
  hasAcceptancePolicy,
  normalizeAcceptancePolicy,
  verifyProofFile,
  type AcceptancePolicy,
  type AcceptancePolicyEvidence,
  type AcceptancePolicyViolationCode,
  type FingerprintComponents,
  type VerifyProofFileOptions,
} from '../index.js';
import { buildSignedCheckpoints, createTestKey, type TestKey } from './fixtures/signedCheckpointFixtures.js';

// ---------------------------------------------------------------------------
// 純関数の表テスト
// ---------------------------------------------------------------------------

type Evidence = AcceptancePolicyEvidence;

const EVENTS = 3;

/** 署名 cp 0 件の coverage (全イベントが未署名の末尾)。density は null (密度要件の対象外)。 */
const unsignedCoverage = (): Evidence['signedCheckpoints'] => ({
  coverage: {
    signedCount: 0,
    lastSignedEventIndex: null,
    coverageRatio: 0,
    unsignedTailEvents: EVENTS,
    terminalAnchored: false,
  },
  density: null,
});

/** `lastSignedEventIndex` まで署名した coverage。`sparse` で密度の判定を選ぶ。 */
const signedCoverage = (lastSignedEventIndex: number, sparse = false): Evidence['signedCheckpoints'] => ({
  coverage: {
    signedCount: lastSignedEventIndex + 1,
    lastSignedEventIndex,
    coverageRatio: (lastSignedEventIndex + 1) / EVENTS,
    unsignedTailEvents: EVENTS - 1 - lastSignedEventIndex,
    terminalAnchored: lastSignedEventIndex === EVENTS - 1,
  },
  density: {
    firstAnchorEventIndex: 0,
    firstAnchorLatencyEvents: 0,
    firstAnchorLatencyServerMs: 0,
    maxGapEvents: 1,
    maxGapServerMs: sparse ? 60_000 : 1_000,
    sparse,
  },
});

const FIXTURES: Record<string, Evidence> = {
  'root only': { rootAnchored: true, examExempt: false, isExam: false, signedCheckpoints: unsignedCoverage() },
  'signed checkpoints only': {
    rootAnchored: false,
    examExempt: false,
    isExam: false,
    signedCheckpoints: signedCoverage(EVENTS - 1),
  },
  'no signed checkpoints': {
    rootAnchored: false,
    examExempt: false,
    isExam: false,
    signedCheckpoints: unsignedCoverage(),
  },
  'sparse anchoring': {
    rootAnchored: true,
    examExempt: false,
    isExam: false,
    signedCheckpoints: signedCoverage(EVENTS - 1, true),
  },
  'final event signed': {
    rootAnchored: true,
    examExempt: false,
    isExam: false,
    signedCheckpoints: signedCoverage(EVENTS - 1),
  },
  'final events unsigned': {
    rootAnchored: true,
    examExempt: false,
    isExam: false,
    signedCheckpoints: signedCoverage(0),
  },
};

const FLAGS = [
  'requireRootAnchor',
  'requireAnchorDensity',
  'requireSignedCheckpoints',
  'requireTerminalAnchor',
] as const;

/** 行 = 証拠の形、列 = 立てた要件 1 つ。値 = 出るべき違反 (無ければ null)。 */
const EXPECTED: Record<string, Record<(typeof FLAGS)[number], AcceptancePolicyViolationCode | null>> = {
  'root only': {
    requireRootAnchor: null,
    requireAnchorDensity: null,
    requireSignedCheckpoints: 'signed-checkpoints-missing',
    requireTerminalAnchor: 'terminal-anchor-missing',
  },
  'signed checkpoints only': {
    requireRootAnchor: 'root-anchor-missing',
    requireAnchorDensity: null,
    requireSignedCheckpoints: null,
    requireTerminalAnchor: null,
  },
  'no signed checkpoints': {
    requireRootAnchor: 'root-anchor-missing',
    requireAnchorDensity: null,
    requireSignedCheckpoints: 'signed-checkpoints-missing',
    requireTerminalAnchor: 'terminal-anchor-missing',
  },
  'sparse anchoring': {
    requireRootAnchor: null,
    requireAnchorDensity: 'anchor-density-sparse',
    requireSignedCheckpoints: null,
    requireTerminalAnchor: null,
  },
  'final event signed': {
    requireRootAnchor: null,
    requireAnchorDensity: null,
    requireSignedCheckpoints: null,
    requireTerminalAnchor: null,
  },
  'final events unsigned': {
    requireRootAnchor: null,
    requireAnchorDensity: null,
    requireSignedCheckpoints: null,
    requireTerminalAnchor: 'terminal-anchor-missing',
  },
};

const TABLE = Object.keys(FIXTURES).flatMap((fixture) =>
  FLAGS.map((flag) => [fixture, flag, EXPECTED[fixture]![flag]] as const)
);

describe('evaluateAcceptancePolicy table (#296)', () => {
  it.each(TABLE)('for "%s" with %s reports %s', (fixture, flag, expected) => {
    const violations = evaluateAcceptancePolicy(FIXTURES[fixture]!, { [flag]: true });
    expect(violations.map((v) => v.code)).toEqual(expected === null ? [] : [expected]);
  });

  it.each(Object.keys(FIXTURES))('reports no violation for "%s" when no requirement is set', (fixture) => {
    expect(evaluateAcceptancePolicy(FIXTURES[fixture]!, {})).toEqual([]);
  });
});

describe('evaluateAcceptancePolicy details (#296)', () => {
  it('attaches the unsigned tail count to terminal-anchor-missing', () => {
    const [violation] = evaluateAcceptancePolicy(FIXTURES['final events unsigned']!, { requireTerminalAnchor: true });
    expect(violation).toEqual({
      code: 'terminal-anchor-missing',
      message: TERMINAL_ANCHOR_MISSING_MESSAGE,
      unsignedTailEvents: 2,
    });
  });

  it('counts every event as the unsigned tail when there is no signed checkpoint', () => {
    const [violation] = evaluateAcceptancePolicy(FIXTURES['no signed checkpoints']!, { requireTerminalAnchor: true });
    expect(violation?.unsignedTailEvents).toBe(EVENTS);
  });

  it('does not require a final signature from a proof with no events', () => {
    const empty: Evidence = {
      rootAnchored: true,
      examExempt: false,
      isExam: false,
      signedCheckpoints: {
        coverage: {
          signedCount: 0,
          lastSignedEventIndex: null,
          coverageRatio: 0,
          unsignedTailEvents: 0,
          terminalAnchored: false,
        },
        density: null,
      },
    };
    expect(evaluateAcceptancePolicy(empty, { requireTerminalAnchor: true })).toEqual([]);
  });

  it('lists every violated requirement, density before root so the error message keeps the old order', () => {
    const evidence: Evidence = { ...FIXTURES['sparse anchoring']!, rootAnchored: false };
    const all: AcceptancePolicy = {
      requireRootAnchor: true,
      requireAnchorDensity: true,
      requireSignedCheckpoints: true,
      requireTerminalAnchor: true,
    };
    expect(evaluateAcceptancePolicy(evidence, all).map((v) => v.code)).toEqual([
      'anchor-density-sparse',
      'root-anchor-missing',
    ]);
  });

  it('uses the density gate message carried over from the signed checkpoint layer', () => {
    const [violation] = evaluateAcceptancePolicy(FIXTURES['sparse anchoring']!, { requireAnchorDensity: true });
    expect(violation?.message).toBe(ANCHOR_DENSITY_SPARSE_MESSAGE);
  });

  it('exempts an exam proof from the root anchor requirement only when its binding is verified (#131)', () => {
    const exam: Evidence = { ...FIXTURES['no signed checkpoints']!, isExam: true, examExempt: true };
    expect(evaluateAcceptancePolicy(exam, { requireRootAnchor: true })).toEqual([]);
  });

  it('tells an unverified exam proof how to be exempted from the root anchor requirement', () => {
    const exam: Evidence = { ...FIXTURES['no signed checkpoints']!, isExam: true, examExempt: false };
    const [violation] = evaluateAcceptancePolicy(exam, { requireRootAnchor: true });
    expect(violation).toEqual({ code: 'root-anchor-missing', message: EXAM_ROOT_ANCHOR_REQUIRED_MESSAGE });
  });

  it.each([
    ['signed-checkpoints-missing', SIGNED_CHECKPOINTS_MISSING_MESSAGE, /signed checkpoints are required/i],
    ['terminal-anchor-missing', TERMINAL_ANCHOR_MISSING_MESSAGE, /final event is required/i],
  ] as const)('explains %s with a message that names the missing requirement', (_code, message, pattern) => {
    // verify-cli は message を Error 行と Policy 節にそのまま出す。空や無関係な文言では採点者が読めない。
    expect(message).toMatch(pattern);
  });

  it('uses the casual root anchor message for a proof without an exam block', () => {
    const [violation] = evaluateAcceptancePolicy(FIXTURES['no signed checkpoints']!, { requireRootAnchor: true });
    expect(violation?.message).toBe(ROOT_ANCHOR_REQUIRED_MESSAGE);
  });
});

describe('normalizeAcceptancePolicy / hasAcceptancePolicy (#296)', () => {
  it('keeps only the four requirements and turns anything but true into false', () => {
    const options = { mode: 'fast', requireRootAnchor: true, requireTerminalAnchor: 1 } as unknown as AcceptancePolicy;
    expect(normalizeAcceptancePolicy(options)).toEqual({
      requireRootAnchor: true,
      requireAnchorDensity: false,
      requireSignedCheckpoints: false,
      requireTerminalAnchor: false,
    });
  });

  it.each(FLAGS)('reports a policy as applied when only %s is set', (flag) => {
    expect(hasAcceptancePolicy(normalizeAcceptancePolicy({ [flag]: true }))).toBe(true);
  });

  it('reports no policy when nothing is set', () => {
    expect(hasAcceptancePolicy(normalizeAcceptancePolicy({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyProofFile 経由
// ---------------------------------------------------------------------------

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (Acceptance Policy Test)',
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
};

const SERVER_NONCE = 'a1'.repeat(32);
const SESSION_ID = 'session-acceptance-policy';

let testKey: TestKey;

beforeAll(async () => {
  testKey = await createTestKey();
});

/**
 * a / b / c を打った proof。
 * - `rootAnchored`: sessionStartToken で root をサーバアンカーするか
 * - `signedEventIndexes`: 署名 cp を打つイベント (`[]` で署名 cp なし。省略時は全イベント)
 * - `serverStepMs`: 署名 cp 間のサーバ時刻の間隔 (60 秒にすると密度が疎になる)
 */
async function buildProof(options: { rootAnchored: boolean; signedEventIndexes?: number[]; serverStepMs?: number }) {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const typingProof = new TypingProof();
  if (options.rootAnchored) {
    const token = await createSessionStartToken(
      { sessionId: SESSION_ID, fingerprintHash },
      {
        serverNonce: SERVER_NONCE,
        issuedAt: '2026-06-12T00:00:00.000Z',
        turnstileVerified: true,
        hostname: 'typedcode.dev',
        action: 'create_tab',
      },
      { keyId: testKey.keyId, privateKey: testKey.privateKey }
    );
    await typingProof.initializeAnchored(fingerprintHash, components, SERVER_NONCE, token);
  } else {
    await typingProof.initialize(fingerprintHash, components);
  }
  let content = '';
  for (const ch of 'abc') {
    await typingProof.recordEvent({
      type: 'contentChange',
      inputType: 'insertText',
      data: ch,
      rangeOffset: content.length,
      rangeLength: 0,
    });
    content += ch;
  }
  const exported = await typingProof.exportProof(content);
  const checkpoints =
    options.signedEventIndexes?.length === 0
      ? exported.checkpoints
      : await buildSignedCheckpoints({
          events: exported.proof.events,
          initialEventChainHash: exported.typingProofData.initialEventChainHash ?? '',
          key: testKey,
          sessionId: SESSION_ID,
          eventIndexes: options.signedEventIndexes,
          serverStepMs: options.serverStepMs,
        });
  return { ...exported, checkpoints, content, language: 'text' };
}

type BuiltProof = Awaited<ReturnType<typeof buildProof>>;

const verify = (proof: BuiltProof, policy: AcceptancePolicy = {}) =>
  verifyProofFile(proof, undefined, {
    mode: 'fast',
    signedCheckpointKeyRegistry: [testKey.registryEntry],
    ...policy,
  } satisfies VerifyProofFileOptions);

const ALL_FLAGS: AcceptancePolicy = {
  requireRootAnchor: true,
  requireAnchorDensity: true,
  requireSignedCheckpoints: true,
  requireTerminalAnchor: true,
};

describe('verifyProofFile with requireSignedCheckpoints (#296)', () => {
  it('reports signed-checkpoints-missing for a proof without signed checkpoints', async () => {
    const result = await verify(await buildProof({ rootAnchored: true, signedEventIndexes: [] }), {
      requireSignedCheckpoints: true,
    });
    expect(result.policy.violations.map((v) => v.code)).toEqual(['signed-checkpoints-missing']);
  });

  it('keeps integrityValid true when only the policy is violated', async () => {
    const result = await verify(await buildProof({ rootAnchored: true, signedEventIndexes: [] }), {
      requireSignedCheckpoints: true,
    });
    expect(result.integrityValid).toBe(true);
  });

  it('fails overall with the violation message as the error message', async () => {
    const result = await verify(await buildProof({ rootAnchored: true, signedEventIndexes: [] }), {
      requireSignedCheckpoints: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toBe(SIGNED_CHECKPOINTS_MISSING_MESSAGE);
  });
});

describe('verifyProofFile with requireTerminalAnchor (#296)', () => {
  it('reports terminal-anchor-missing with the unsigned tail when only the first event is signed', async () => {
    const result = await verify(await buildProof({ rootAnchored: true, signedEventIndexes: [0] }), {
      requireTerminalAnchor: true,
    });
    expect(result.policy.violations).toEqual([
      { code: 'terminal-anchor-missing', message: TERMINAL_ANCHOR_MISSING_MESSAGE, unsignedTailEvents: 2 },
    ]);
    expect(result.valid).toBe(false);
  });

  it('accepts a proof whose signed checkpoints reach the final event', async () => {
    const result = await verify(await buildProof({ rootAnchored: true }), { requireTerminalAnchor: true });
    expect(result.policy.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('verifyProofFile without a policy (#296)', () => {
  it('applies no requirement and reports no violation', async () => {
    const result = await verify(await buildProof({ rootAnchored: false, signedEventIndexes: [] }));
    expect(result.policy).toEqual({
      applied: {
        requireRootAnchor: false,
        requireAnchorDensity: false,
        requireSignedCheckpoints: false,
        requireTerminalAnchor: false,
      },
      evaluated: true,
      violations: [],
    });
  });

  it('keeps valid equal to integrityValid', async () => {
    const result = await verify(await buildProof({ rootAnchored: false, signedEventIndexes: [0] }));
    expect(result.valid).toBe(true);
    expect(result.integrityValid).toBe(true);
  });
});

describe('verifyProofFile with requireAnchorDensity (#296)', () => {
  it('leaves a proof without signed checkpoints out of the density requirement', async () => {
    const result = await verify(await buildProof({ rootAnchored: true, signedEventIndexes: [] }), {
      requireAnchorDensity: true,
    });
    expect(result.policy.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('keeps the signed checkpoint layer valid and reports anchor-density-sparse for sparse anchoring', async () => {
    // サーバ時刻が 60 秒間隔 (閾値 50 秒超え) で、署名そのものは健全。
    const result = await verify(await buildProof({ rootAnchored: true, serverStepMs: 60_000 }), {
      requireAnchorDensity: true,
    });
    expect(result.signedCheckpoints?.valid).toBe(true);
    expect(result.signedCheckpoints?.density?.sparse).toBe(true);
    expect(result.integrityValid).toBe(true);
    expect(result.policy.violations.map((v) => v.code)).toEqual(['anchor-density-sparse']);
    expect(result.valid).toBe(false);
  });
});

describe('verifyProofFile on a tampered proof (#296)', () => {
  /** 最終 content だけを書き換える (チェーンの再生結果と食い違う)。署名 cp も root も無い = 全要件に違反する形。 */
  const tampered = async () => ({
    ...(await buildProof({ rootAnchored: false, signedEventIndexes: [] })),
    content: 'abX',
  });

  it('reports integrityValid false', async () => {
    const result = await verify(await tampered(), ALL_FLAGS);
    expect(result.integrityValid).toBe(false);
  });

  it('does not evaluate the policy, so violations never mix with tampering', async () => {
    const result = await verify(await tampered(), ALL_FLAGS);
    expect(result.policy.evaluated).toBe(false);
    expect(result.policy.violations).toEqual([]);
    expect(result.policy.applied).toEqual(ALL_FLAGS);
  });

  it('keeps the integrity reason as the error message', async () => {
    const result = await verify(await tampered(), ALL_FLAGS);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).not.toMatch(/required/);
  });
});
