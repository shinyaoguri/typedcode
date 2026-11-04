/**
 * 凍結 proof (frozen proofs) を**一度だけ**生成したスクリプト (#581)。
 *
 * **作り直さないこと。** このディレクトリの proof は「過去に出回った proof を、今の検証器が今も同じ結論で
 * 検証できるか」を見る互換の検査に使う。記録側と検証側は同じ shared の関数 (deterministicStringify /
 * computeAnchoredChainRoot / hashSignedCheckpointPayload / computeExamChainRoot) を使うので、両側を同時に
 * 変えるとユニットはすべて緑のまま、出回っている proof だけが検証できなくなる。fixture を作り直すと
 * その変化が新しい fixture に焼き込まれ、検査の意味が無くなる。`frozenProofs.test.ts` が落ちたら、
 * fixture ではなく**検証器側が既存の proof を壊している**と読むこと (README.md)。
 *
 * 記録として残している手順 (新しい形の proof を足すときは、既存ファイルを上書きせず別名で足す):
 *
 *   npx tsx packages/shared/src/__tests__/fixtures/frozen-proofs/generate.mts
 *   npx biome format --write packages/shared/src/__tests__/fixtures/frozen-proofs/
 *
 * - テスト鍵 (署名 cp / sessionStartToken 用の checkpoint 鍵、出題者鍵) は実行のたびに新しく作り、
 *   公開鍵の registry エントリだけを書き出す。秘密鍵は捨てる (作り直さない前提なので要らない)
 * - PoSW は本物を計算する。Node に Worker は無いので、`postMessage` が throw する偽 Worker を渡して
 *   PoswManager の main-thread fallback に落とす (verify-cli の `generate-valid.mts` と同じ作法)
 * - 署名 cp は shared の `createSignedCheckpointEnvelope` (Workers の署名エンドポイントと同じ関数) で作り、
 *   連鎖は editor の `SignedCheckpointService` と同じ規則 (checkpointIndex 連番・previousSignedCheckpointHash・
 *   totalEventsSincePrevious) で繋ぐ
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EXAM_BUNDLE_SCHEMA,
  PROOF_FORMAT_VERSION,
  TypingProof,
  buildExamPackage,
  computeBundleProblemHash,
  computeExamPackageHash,
  computeHash,
  computeProblemContentHash,
  createSessionStartToken,
  createSignedCheckpointEnvelope,
  encodeExamBundle,
  hashSignedCheckpointPayload,
  type CheckpointData,
  type CheckpointPublicKey,
  type ExamAuthorityKey,
  type ExamBundle,
  type ExamSessionContext,
  type FingerprintComponents,
  type HumanAttestationEventData,
  type InputType,
  type RecordEventInput,
  type StoredEvent,
} from '../../../index.js';

const OUT_DIR = fileURLToPath(new URL('./', import.meta.url));

const CHECKPOINT_KEY_ID = 'frozen-fixture-checkpoint-0001';
const EXAM_AUTHORITY_KEY_ID = 'frozen-fixture-exam-0001';
const KEY_VALID_FROM = '2026-01-01T00:00:00.000Z';
const HOSTNAME = 'typedcode.dev';
/** 出題者ツールの既定 (オープンな提出窓。ADR-0013) */
const OPEN_DEADLINE = '2999-12-31T23:59:59.999Z';
/**
 * Argon2id は極小パラメータで封印する (テストの復号を速くするため。暗号の正しさは params に非依存で、
 * params は manifest に載り署名 core に含まれる)。
 */
const FAST_KDF_PARAMS = { memKiB: 256, iterations: 1, parallelism: 1 } as const;

const components: FingerprintComponents = {
  userAgent: 'TypedCode frozen proof fixture',
  language: 'ja',
  languages: ['ja', 'en'],
  platform: 'FixtureOS',
  hardwareConcurrency: 8,
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
  timezone: 'Asia/Tokyo',
  timezoneOffset: -540,
  canvas: 'frozen-fixture',
  webgl: { vendor: 'frozen-fixture', renderer: 'frozen-fixture' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
};

/** `postMessage` が throw する Worker。PoswManager が main-thread の実 PoSW に落ちる。 */
class FailingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(): void {
    throw new Error('no worker in Node');
  }
  terminate(): void {}
}

async function generateEcdsaKey(): Promise<{ privateKey: CryptoKey; publicKeyJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { privateKey: pair.privateKey, publicKeyJwk };
}

function writeJson(name: string, value: unknown): void {
  const path = `${OUT_DIR}${name}`;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

/** offset から長さ length の範囲を Monaco の 1-origin range にする (編集前の content で数える)。 */
function rangeAt(content: string, offset: number, length: number): RecordEventInput['range'] {
  const position = (at: number): { line: number; column: number } => {
    const before = content.slice(0, at).split('\n');
    return { line: before.length, column: (before[before.length - 1]?.length ?? 0) + 1 };
  };
  const start = position(offset);
  const end = position(offset + length);
  return { startLineNumber: start.line, startColumn: start.column, endLineNumber: end.line, endColumn: end.column };
}

/**
 * editor (EditorController / OperationDetector) と同じ形で contentChange を記録し、手元の content を進める。
 */
class Session {
  content = '';
  constructor(readonly proof: TypingProof) {}

  async record(input: RecordEventInput): Promise<void> {
    const result = await this.proof.recordEvent(input);
    if (!result.recorded) throw new Error(`event was not recorded: ${input.type}`);
  }

  async change(offset: number, deleteLength: number, text: string, inputType: InputType): Promise<void> {
    const range = rangeAt(this.content, offset, deleteLength);
    await this.record({
      type: 'contentChange',
      inputType,
      data: text,
      rangeOffset: offset,
      rangeLength: deleteLength,
      range,
      isMultiLine: range!.startLineNumber !== range!.endLineNumber,
      description: inputType,
      ...(deleteLength > 0 && { deletedLength: deleteLength }),
      ...(text.length > 0 && { insertedText: text, insertLength: text.length }),
      ...(deleteLength > 0 && text.length === 0 && { deleteDirection: 'backward' as const }),
    });
    this.content = this.content.slice(0, offset) + text + this.content.slice(offset + deleteLength);
  }

  /** 1 文字ずつ打鍵する (改行は insertLineBreak)。 */
  async type(text: string, at = this.content.length): Promise<void> {
    let offset = at;
    for (const ch of text) {
      await this.change(offset, 0, ch, ch === '\n' ? 'insertLineBreak' : 'insertText');
      offset += ch.length;
    }
  }

  /** Backspace 1 回 (offset の直前の 1 文字を消す)。 */
  async backspace(offset = this.content.length): Promise<void> {
    await this.change(offset - 1, 1, '', 'deleteContentBackward');
  }

  /**
   * 外部からの貼り付け。editor は paste DOM イベントで `externalInput` (insertFromPaste) を記録し、
   * 続く Monaco の変更を contentChange (複数文字・改行なし = insertReplacementText) として記録する。
   */
  async externalPaste(text: string, at = this.content.length): Promise<void> {
    await this.record({
      type: 'externalInput',
      inputType: 'insertFromPaste',
      data: text,
      rangeLength: text.length,
      range: rangeAt(this.content, at, 0),
      description: `Paste detected (${text.length} chars)`,
    });
    await this.change(at, 0, text, 'insertReplacementText');
  }

  /** 範囲を選択して上から打つ (Monaco は replaceContent として通知する)。 */
  async replaceRange(offset: number, length: number, text: string): Promise<void> {
    await this.change(offset, length, text, 'replaceContent');
  }
}

/** CheckpointManager.createCheckpoint と同じ contentHash の規則 */
async function checkpointContentHash(event: StoredEvent): Promise<string> {
  if (!event.data) return '';
  return computeHash(typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
}

/**
 * export された checkpoints と追加で打ちたい eventIndex の和集合に、editor の SignedCheckpointService と
 * 同じ連鎖規則で署名を付ける。各 cp の時刻は「イベントの記録時刻 + 遅延」で、サーバ時刻は単調増加させる。
 */
async function signCheckpoints(options: {
  events: StoredEvent[];
  exported: CheckpointData[];
  extraEventIndexes: number[];
  initialEventChainHash: string;
  sessionId: string;
  tabId: string;
  wallOriginMs: number;
  privateKey: CryptoKey;
}): Promise<CheckpointData[]> {
  const indexes = [...new Set([...options.exported.map((cp) => cp.eventIndex), ...options.extraEventIndexes])].sort(
    (a, b) => a - b
  );

  const out: CheckpointData[] = [];
  let previousSignedCheckpointHash: string | null = null;
  let lastEventIndex = -1;
  let lastServerMs = -Infinity;
  let firstSeenAt: string | null = null;

  for (let i = 0; i < indexes.length; i++) {
    const eventIndex = indexes[i]!;
    const event = options.events[eventIndex];
    if (!event) throw new Error(`checkpoint eventIndex ${eventIndex} out of range`);
    const contentHash = await checkpointContentHash(event);
    const exported = options.exported.find((cp) => cp.eventIndex === eventIndex);
    if (exported && exported.contentHash !== contentHash) {
      throw new Error(`contentHash rule drifted from CheckpointManager at event ${eventIndex}`);
    }
    const clientMs = Math.round(options.wallOriginMs + event.timestamp) + 30;
    const serverMs = Math.max(lastServerMs + 1, clientMs + 120);
    const serverTimestamp = new Date(serverMs).toISOString();
    firstSeenAt ??= serverTimestamp;

    const envelope = await createSignedCheckpointEnvelope(
      {
        sessionId: options.sessionId,
        tabId: options.tabId,
        checkpointIndex: i,
        eventIndex,
        initialEventChainHash: options.initialEventChainHash,
        chainHash: event.hash,
        contentHash,
        previousSignedCheckpointHash,
        totalEventsSincePrevious: eventIndex - lastEventIndex,
        clientTimestamp: new Date(clientMs).toISOString(),
      },
      { serverTimestamp, firstSeenAt },
      { keyId: CHECKPOINT_KEY_ID, privateKey: options.privateKey }
    );
    out.push({ eventIndex, hash: event.hash, timestamp: event.timestamp, contentHash, signature: envelope });
    previousSignedCheckpointHash = await hashSignedCheckpointPayload(envelope.payload);
    lastEventIndex = eventIndex;
    lastServerMs = serverMs;
  }
  return out;
}

function bestEffortAttestation(action: string, signature: string): HumanAttestationEventData {
  return {
    verified: false,
    score: 0,
    action,
    timestamp: new Date().toISOString(),
    hostname: HOSTNAME,
    signature,
    success: false,
  };
}

// ---------------------------------------------------------------------------
// 鍵 (公開鍵だけを書き出す)
// ---------------------------------------------------------------------------

const checkpointKey = await generateEcdsaKey();
const checkpointRegistryEntry: CheckpointPublicKey = {
  keyId: CHECKPOINT_KEY_ID,
  algorithm: 'ECDSA-P256',
  publicKeyJwk: checkpointKey.publicKeyJwk,
  status: 'active',
  validFrom: KEY_VALID_FROM,
  description:
    'Test key for frozen proof fixtures (#581). Private key discarded; never add to the production registry.',
};
const examAuthorityKey = await generateEcdsaKey();
const examAuthorityRegistryEntry: ExamAuthorityKey = {
  keyId: EXAM_AUTHORITY_KEY_ID,
  algorithm: 'ECDSA-P256',
  publicKeyJwk: examAuthorityKey.publicKeyJwk,
  status: 'active',
  validFrom: KEY_VALID_FROM,
};

const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));

// fallback 時の console.warn (Worker 不在) は生成スクリプトの出力として不要なので黙らせる
const originalWarn = console.warn;
console.warn = () => {};

// ---------------------------------------------------------------------------
// 1. casual + sessionStartToken + 署名 cp (anchored)
// ---------------------------------------------------------------------------

async function generateCasual(): Promise<Record<string, unknown>> {
  const sessionId = 'frozen-casual-session';
  const tabId = 'frozen-casual-tab';
  const serverNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const issuedAt = new Date().toISOString();
  const token = await createSessionStartToken(
    { sessionId, fingerprintHash },
    { serverNonce, issuedAt, turnstileVerified: true, hostname: HOSTNAME, action: 'create_tab' },
    { keyId: CHECKPOINT_KEY_ID, privateKey: checkpointKey.privateKey }
  );

  const proof = new TypingProof();
  const wallOriginMs = Date.now();
  await proof.initializeAnchored(
    fingerprintHash,
    components,
    serverNonce,
    token,
    new FailingWorker() as unknown as Worker
  );
  const s = new Session(proof);

  await proof.recordHumanAttestation({
    verified: true,
    score: 1,
    action: 'create_tab',
    timestamp: issuedAt,
    hostname: HOSTNAME,
    signature: `session-start-token:${CHECKPOINT_KEY_ID}`,
    success: true,
  });
  await s.type('let x = 1;\n');
  await s.type('let y = 2;;');
  await s.backspace();
  await s.type('\n');
  await s.externalPaste('console.log(x + y);');
  // "let x = 1;" の 1 を選択して 3 を打つ
  await s.replaceRange('let x = '.length, 1, '3');
  await proof.recordPreExportAttestation({
    verified: true,
    score: 1,
    action: 'export_proof',
    timestamp: new Date().toISOString(),
    hostname: HOSTNAME,
    signature: 'unsigned',
    success: true,
  });

  const exported = await proof.exportProof(s.content);
  const events = exported.proof.events;
  const checkpoints = await signCheckpoints({
    events,
    exported: exported.checkpoints,
    extraEventIndexes: [8, 18],
    initialEventChainHash: exported.typingProofData.initialEventChainHash!,
    sessionId,
    tabId,
    wallOriginMs,
    privateKey: checkpointKey.privateKey,
  });
  return { ...exported, checkpoints, mode: 'casual', filename: 'main', content: s.content, language: 'javascript' };
}

// ---------------------------------------------------------------------------
// 2. exam v1 (単一問題、root = fp ‖ nonce ‖ packageHash ‖ startToken)
// ---------------------------------------------------------------------------

async function generateExamV1(): Promise<{ proof: Record<string, unknown>; manifest: unknown }> {
  const startToken = 'K7M2Q9XR';
  const plaintext = '# Problem 1\n\nAssign 42 to x.\n';
  const manifest = await buildExamPackage(
    {
      formatVersion: 1,
      examId: 'frozen-exam-v1',
      problemId: 'p1',
      variant: null,
      kdf: {
        algorithm: 'argon2id',
        salt: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
        params: { ...FAST_KDF_PARAMS },
      },
      releaseTime: new Date(Date.now() - 3600_000).toISOString(),
      deadline: OPEN_DEADLINE,
      allowed: { languages: ['c'] },
      keyId: EXAM_AUTHORITY_KEY_ID,
      algorithm: 'ECDSA-P256',
    },
    plaintext,
    startToken,
    { keyId: EXAM_AUTHORITY_KEY_ID, privateKey: examAuthorityKey.privateKey }
  );
  const examContext: ExamSessionContext = {
    examId: manifest.examId,
    problemId: manifest.problemId,
    variant: manifest.variant,
    packageHash: await computeExamPackageHash(manifest),
    problemContentHash: await computeProblemContentHash(plaintext),
    startToken,
  };

  const proof = new TypingProof();
  await proof.initializeExam(fingerprintHash, components, examContext, new FailingWorker() as unknown as Worker);
  const s = new Session(proof);
  await proof.recordHumanAttestation(bestEffortAttestation('exam_start', 'unsigned'));
  await proof.recordExamOpened({
    examId: examContext.examId,
    problemId: examContext.problemId,
    variant: examContext.variant,
    packageHash: examContext.packageHash,
    problemContentHash: examContext.problemContentHash,
    openedAt: new Date().toISOString(),
  });
  await s.type('x = 41');
  await s.backspace();
  await s.type('2;');
  await proof.recordPreExportAttestation(bestEffortAttestation('export_proof', ''));

  const exported = await proof.exportProof(s.content);
  return {
    proof: { ...exported, mode: 'exam', filename: 'p1', content: s.content, language: 'c' },
    manifest,
  };
}

// ---------------------------------------------------------------------------
// 3. exam v2 (N問バンドル、root に per-problem problemContentHash を連結) + 署名 cp
// ---------------------------------------------------------------------------

async function generateExamV2(): Promise<{ proof: Record<string, unknown>; manifest: unknown }> {
  const startToken = 'H4D8W2NP';
  const starter = '/* TODO */\n';
  const bundle: ExamBundle = {
    schema: EXAM_BUNDLE_SCHEMA,
    problems: [
      {
        problemId: 'p1',
        statement: '# Problem 1\n\nStore the sum of 1 and 2 in s.\n',
        starter: { filename: 'p1.c', language: 'c', content: starter },
      },
      { problemId: 'p2', statement: '# Problem 2\n\nPrint the product of 6 and 7.\n' },
    ],
  };
  const manifest = await buildExamPackage(
    {
      formatVersion: 1,
      examId: 'frozen-exam-v2',
      // バンドルの manifest.problemId は固定ラベル (editor の examPackageAuthoring と同じ)
      problemId: 'bundle',
      variant: null,
      kdf: {
        algorithm: 'argon2id',
        salt: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
        params: { ...FAST_KDF_PARAMS },
      },
      releaseTime: new Date(Date.now() - 3600_000).toISOString(),
      deadline: OPEN_DEADLINE,
      allowed: { languages: ['c'] },
      keyId: EXAM_AUTHORITY_KEY_ID,
      algorithm: 'ECDSA-P256',
    },
    encodeExamBundle(bundle),
    startToken,
    { keyId: EXAM_AUTHORITY_KEY_ID, privateKey: examAuthorityKey.privateKey }
  );
  const problem = bundle.problems[0]!;
  const examContext: ExamSessionContext = {
    examId: manifest.examId,
    problemId: problem.problemId,
    variant: manifest.variant,
    packageHash: await computeExamPackageHash(manifest),
    problemContentHash: await computeBundleProblemHash(problem),
    startToken,
    rootBinding: 'v2',
  };

  const proof = new TypingProof();
  const wallOriginMs = Date.now();
  await proof.initializeExam(fingerprintHash, components, examContext, new FailingWorker() as unknown as Worker);
  const s = new Session(proof);
  await proof.recordHumanAttestation(bestEffortAttestation('exam_start', 'unsigned'));
  await proof.recordExamOpened({
    examId: examContext.examId,
    problemId: examContext.problemId,
    variant: examContext.variant,
    packageHash: examContext.packageHash,
    problemContentHash: examContext.problemContentHash,
    openedAt: new Date().toISOString(),
  });
  // starter は「与えられた雛形」として注入イベントで記録する (editor main.ts と同じ)
  await proof.recordTemplateInjection({
    templateName: `${manifest.examId}/${problem.problemId}`,
    templateHash: examContext.problemContentHash,
    filename: 'p1.c',
    content: starter,
    contentHash: await computeHash(starter),
    contentLength: starter.length,
    totalFilesInTemplate: 1,
    injectionSource: 'file_import',
  });
  s.content = starter;
  // "TODO" を選択して "sum" に打ち替える
  await s.replaceRange('/* '.length, 'TODO'.length, 's');
  await s.type('um', '/* s'.length);
  await s.type('s=3;');
  await proof.recordPreExportAttestation(bestEffortAttestation('export_proof', ''));

  const exported = await proof.exportProof(s.content);
  const checkpoints = await signCheckpoints({
    events: exported.proof.events,
    exported: exported.checkpoints,
    extraEventIndexes: [5],
    initialEventChainHash: exported.typingProofData.initialEventChainHash!,
    sessionId: 'frozen-exam-v2-session',
    tabId: 'frozen-exam-v2-tab-p1',
    wallOriginMs,
    privateKey: checkpointKey.privateKey,
  });
  return {
    proof: { ...exported, checkpoints, mode: 'exam', filename: 'p1.c', content: s.content, language: 'c' },
    manifest,
  };
}

const casual = await generateCasual();
const examV1 = await generateExamV1();
const examV2 = await generateExamV2();
console.warn = originalWarn;

writeJson('checkpoint-key.json', checkpointRegistryEntry);
writeJson('exam-authority-key.json', examAuthorityRegistryEntry);
writeJson('casual-anchored.proof.json', casual);
writeJson('exam-v1.proof.json', examV1.proof);
writeJson('exam-v1.tcexam.json', examV1.manifest);
writeJson('exam-v2.proof.json', examV2.proof);
writeJson('exam-v2.tcexam.json', examV2.manifest);
console.log(`PROOF_FORMAT_VERSION=${PROOF_FORMAT_VERSION}`);
