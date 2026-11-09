/**
 * 改ざん検出の性質テスト (#595)
 *
 * 改ざん検出の仕様は「どこを変えても落ちる」なので、手で選んだ例ではなく fast-check で
 * 生成した正規のセッションと改ざんの組で縛る。対象は fast モードの `verifyProofFile`
 * (PoSW の再計算だけを省き、チェーン・内容の再生・メタデータ・checkpoint は全部見る経路)。
 *
 * - 生成器: ランダムな操作列 (挿入・削除・カーソル移動・フォーカス) を実際の `TypingProof` に
 *   記録して export する。時計 (`performance.now`) は生成した間隔で単調に進める注入にするので、
 *   同じシードからは同じ操作列・timestamp の proof が組み上がる (root の nonce と hash は実行ごとに
 *   変わるが、性質はその値に依らない)。PoSW は setup.ts の Worker モックが返す偽値
 *   (fast モードは反復を再計算しない)
 * - 改ざん: ハッシュ対象フィールド (`pickHashedEventFields` の定義そのもの) を 1 つ変える /
 *   2 イベントの入替 / 1 イベントの削除 / 1 イベントの複製。構造の改ざんは sequence を振り直す
 *   (攻撃者が自明な連番の崩れを直す) 版も生成し、sequence の検査の先にある照合まで届かせる。
 *   previousHash の照合だけは hash の再計算と重なるので、hash をすべて振り直した偽造で別に縛る (末尾)
 * - 偽陽性の除外: 改ざん後のハッシュ対象が元と同じ直列化になる組 (`-0` と `0` など) は
 *   `fc.pre` で捨てる。入替の相手は index を mod で選び直して同じ index を引かない
 *
 * 実装は変えない。シードを固定して CI の時間を延ばさない (#595 の目安: 追加 10 秒以内)。
 */

import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  TypingProof,
  computeHash,
  deterministicStringify,
  verifyProofFile,
  type EventHashData,
  type FingerprintComponents,
  type ProofFile,
  type RecordEventInput,
  type StoredEvent,
} from '../index.js';
import { pickHashedEventFields } from '../verification.js';

/** 失敗したら fast-check が出すシードと path で再現できる。値を変えると生成列が変わる */
const FC_PARAMS = { seed: 595, numRuns: 300 } as const;

const COMPONENTS: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (Property Test)',
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

let fingerprintHash: string;

// ===== 時計の注入 =====
// TypingProof は timestamp を `performance.now() - startTime` で取る。実時間だとシードを固定しても
// proof が実行ごとに変わるので、生成した間隔で進める時計に差し替える。
let clockMs = 0;
let clockSpy: MockInstance<() => number>;

beforeAll(async () => {
  fingerprintHash = await computeHash(JSON.stringify(COMPONENTS, null, 0));
});

beforeEach(() => {
  clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
});

afterEach(() => {
  clockSpy.mockRestore();
});

// ===== 正規のセッションの生成 =====

/** 操作 1 つ = 記録するイベント 1 つ。`gapMs` は直前の操作からの経過 (0 なら記録側が単調に補正する) */
type Op = { gapMs: number } & (
  | { kind: 'insert'; at: number; text: string }
  | { kind: 'delete'; at: number; length: number }
  | { kind: 'cursor'; lineNumber: number; column: number }
  | { kind: 'focus'; focused: boolean }
);

const gapArb = fc.integer({ min: 0, max: 2_000 });

/** 最後の操作から export までの経過 */
const EXPORT_DELAY_MS = 1_000;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('insert' as const),
    at: fc.nat(),
    text: fc.string({ unit: fc.constantFrom('a', 'b', 'x', ' ', '\n'), minLength: 1, maxLength: 3 }),
    gapMs: gapArb,
  }),
  fc.record({ kind: fc.constant('delete' as const), at: fc.nat(), length: fc.nat(), gapMs: gapArb }),
  fc.record({
    kind: fc.constant('cursor' as const),
    lineNumber: fc.integer({ min: 1, max: 5 }),
    column: fc.integer({ min: 1, max: 10 }),
    gapMs: gapArb,
  }),
  fc.record({ kind: fc.constant('focus' as const), focused: fc.boolean(), gapMs: gapArb })
);

const sessionArb = (minEvents: number): fc.Arbitrary<Op[]> => fc.array(opArb, { minLength: minEvents, maxLength: 8 });

/** 操作を現在の文書に当てはめて、記録する入力と適用後の文書を返す (offset は文書の長さで丸める) */
function toRecordInput(op: Op, content: string): { input: RecordEventInput; next: string } {
  switch (op.kind) {
    case 'insert': {
      const offset = op.at % (content.length + 1);
      return {
        input: {
          type: 'contentChange',
          inputType: op.text === '\n' ? 'insertLineBreak' : 'insertText',
          data: op.text,
          rangeOffset: offset,
          rangeLength: 0,
        },
        next: content.slice(0, offset) + op.text + content.slice(offset),
      };
    }
    case 'delete': {
      if (content.length === 0) {
        // 消す文字が無いときはカーソル移動として記録する (操作 1 つ = イベント 1 つを保つ)
        return { input: { type: 'cursorPositionChange', data: { lineNumber: 1, column: 1 } }, next: content };
      }
      const offset = op.at % content.length;
      const rangeLength = 1 + (op.length % (content.length - offset));
      return {
        input: {
          type: 'contentChange',
          inputType: 'deleteContentForward',
          data: '',
          rangeOffset: offset,
          rangeLength,
        },
        next: content.slice(0, offset) + content.slice(offset + rangeLength),
      };
    }
    case 'cursor':
      return {
        input: { type: 'cursorPositionChange', data: { lineNumber: op.lineNumber, column: op.column } },
        next: content,
      };
    case 'focus':
      return { input: { type: 'focusChange', data: { focused: op.focused } }, next: content };
  }
}

/** 操作列を実際の TypingProof に記録して export し、検証器に渡す形 (content 付き) にする */
async function buildSession(ops: readonly Op[]): Promise<ProofFile> {
  clockMs = 0;
  const recorder = new TypingProof();
  await recorder.initialize(fingerprintHash, COMPONENTS);
  let content = '';
  for (const op of ops) {
    clockMs += op.gapMs;
    const { input, next } = toRecordInput(op, content);
    await recorder.recordEvent(input);
    content = next;
  }
  // export は最後の打鍵より後。記録側は同じ時刻の打鍵を 0.001ms ずつ進めるので、時計を止めたまま
  // export すると申告の totalTypingTime (export 時の経過) が最後の timestamp を下回って invalid になる
  clockMs += EXPORT_DELAY_MS;
  const exported = await recorder.exportProof(content);
  recorder.dispose();
  return { ...exported, content, language: 'c' };
}

const verifyFast = (proof: ProofFile) => verifyProofFile(proof, undefined, { mode: 'fast' });

/** 改ざんの前後でイベント列のハッシュ対象が変わったか (変わっていない組は改ざんではない) */
const hashedView = (events: readonly StoredEvent[]): string =>
  deterministicStringify(events.map((event) => ({ ...pickHashedEventFields(event), posw: event.posw })));

// ===== 改ざん =====

/** ハッシュ対象フィールドの一覧。`pickHashedEventFields` (単一定義) から取るので、定義が増えれば生成も増える */
const HASHED_FIELDS = Object.keys(pickHashedEventFields({} as EventHashData)) as (keyof Omit<EventHashData, 'posw'>)[];

const hex64Arb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));

/** 差し替える値。型の合う値 (数・文字列・範囲・ハッシュ) も合わない値 (真偽・任意のオブジェクト) も混ぜる */
const replacementValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.integer({ min: -2, max: 200 }),
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
  fc.string({ maxLength: 4 }),
  fc.boolean(),
  hex64Arb,
  fc.constantFrom('contentChange', 'cursorPositionChange', 'focusChange', 'insertText', 'deleteContentForward'),
  fc.record(
    {
      startLineNumber: fc.integer({ min: 1, max: 3 }),
      startColumn: fc.integer({ min: 1, max: 5 }),
      endLineNumber: fc.integer({ min: 1, max: 3 }),
      endColumn: fc.integer({ min: 1, max: 5 }),
    },
    { noNullPrototype: true }
  ),
  fc.dictionary(fc.string({ maxLength: 3 }), fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 3 })), {
    maxKeys: 2,
    noNullPrototype: true,
  })
);

/** 値をまるごと差し替えるか、数なら元の値をずらす (sequence や timestamp の「近い値」を出すため) */
type Replacement = { kind: 'set'; value: unknown } | { kind: 'shift'; delta: number };

const replacementArb: fc.Arbitrary<Replacement> = fc.oneof(
  replacementValueArb.map((value) => ({ kind: 'set' as const, value })),
  fc
    .integer({ min: -3, max: 3 })
    .filter((delta) => delta !== 0)
    .map((delta) => ({ kind: 'shift' as const, delta }))
);

function applyReplacement(original: unknown, replacement: Replacement): unknown {
  if (replacement.kind === 'set') return replacement.value;
  return typeof original === 'number' ? original + replacement.delta : replacement.delta;
}

/** 選んだ 2 つの nat から、長さ n の配列の異なる 2 index を作る (同じ index を引かない) */
function distinctPair(n: number, a: number, b: number): [number, number] {
  const i = a % n;
  const j = (i + 1 + (b % (n - 1))) % n;
  return [i, j];
}

/** 攻撃者が連番の崩れを直す: sequence を位置どおりに振り直す */
function renumber(events: StoredEvent[]): void {
  events.forEach((event, index) => {
    event.sequence = index;
  });
}

/**
 * テスト用の偽造器: `start` 以降の各イベントの hash を、検証器と同じ式で振り直す。
 * 後続の previousHash は振り直した hash に繋ぎ直し、最終ハッシュ・typingProofHash・checkpoint の
 * hash も合わせる (PoSW は fast モードで再計算されないので触らない)。`start` の previousHash だけは
 * 呼び出し側が置いた値のまま残す。
 */
async function rechainFrom(proof: ProofFile, start: number): Promise<void> {
  const events = proof.proof.events;
  for (let i = start; i < events.length; i++) {
    const event = events[i] as StoredEvent;
    if (i > start) event.previousHash = (events[i - 1] as StoredEvent).hash;
    // verifyChain は先頭イベントでは自身の previousHash、以降は直前の hash を連結する
    const running = i === 0 ? event.previousHash : (events[i - 1] as StoredEvent).hash;
    const hashData: EventHashData = { ...pickHashedEventFields(event), posw: event.posw };
    event.hash = await computeHash(String(running) + deterministicStringify(hashData));
  }
  const finalHash = (events[events.length - 1] as StoredEvent).hash;
  proof.proof.finalHash = finalHash;
  proof.typingProofData.finalEventChainHash = finalHash;
  proof.typingProofHash = await computeHash(JSON.stringify(proof.typingProofData));
  for (const checkpoint of proof.checkpoints ?? []) {
    checkpoint.hash = (events[checkpoint.eventIndex] as StoredEvent).hash;
  }
}

/**
 * `index` のイベントの previousHash を `forged` に書き換え、そこから後を偽造器で繋ぎ直す。
 * 元の値と同じなら何もせず false を返す (呼び出し側が `fc.pre` で捨てる)。
 */
async function forgePreviousHash(proof: ProofFile, index: number, forged: string): Promise<boolean> {
  const event = proof.proof.events[index] as StoredEvent;
  if (event.previousHash === forged) return false;
  event.previousHash = forged;
  await rechainFrom(proof, index);
  return true;
}

// ===== 性質 =====

describe('verifyProofFile (fast) tamper detection properties (#595)', () => {
  it('accepts every proof recorded from a generated editing session', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb(1), async (ops) => {
        const result = await verifyFast(await buildSession(ops));

        expect(result.valid, result.errorMessage).toBe(true);
      }),
      FC_PARAMS
    );
  });

  it('rejects a proof in which any one hashed field of any one event was changed', async () => {
    await fc.assert(
      fc.asyncProperty(
        sessionArb(1),
        fc.nat(),
        fc.constantFrom(...HASHED_FIELDS),
        replacementArb,
        async (ops, pick, field, replacement) => {
          const proof = await buildSession(ops);
          const events = proof.proof.events;
          const before = hashedView(events);
          const event = events[pick % events.length] as StoredEvent;
          const value = applyReplacement(event[field], replacement);
          // 文字列でも null でもない inputType では、検証器が valid を返す前に throw する
          // (`recomputeProofMetadata` の `inputType?.startsWith`)。受理はしないが結論も返さないので
          // 別件 (#678) として報告し、この性質では生成しない。#678 を直したらこの除外を外す
          fc.pre(!(field === 'inputType' && value !== null && typeof value !== 'string'));
          (event as unknown as Record<string, unknown>)[field] = value;
          fc.pre(hashedView(events) !== before);

          expect((await verifyFast(proof)).valid).toBe(false);
        }
      ),
      FC_PARAMS
    );
  });

  it('rejects a proof in which any two events were swapped, even with sequence numbers rewritten', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb(2), fc.nat(), fc.nat(), fc.boolean(), async (ops, a, b, rewrite) => {
        const proof = await buildSession(ops);
        const events = proof.proof.events;
        const before = hashedView(events);
        const [i, j] = distinctPair(events.length, a, b);
        [events[i], events[j]] = [events[j] as StoredEvent, events[i] as StoredEvent];
        if (rewrite) renumber(events);
        fc.pre(hashedView(events) !== before);

        expect((await verifyFast(proof)).valid).toBe(false);
      }),
      FC_PARAMS
    );
  });

  it('rejects a proof from which any one event was deleted, even with sequence numbers rewritten', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb(1), fc.nat(), fc.boolean(), async (ops, pick, rewrite) => {
        const proof = await buildSession(ops);
        const events = proof.proof.events;
        events.splice(pick % events.length, 1);
        if (rewrite) renumber(events);

        expect((await verifyFast(proof)).valid).toBe(false);
      }),
      FC_PARAMS
    );
  });

  it('rejects a proof in which any one event was duplicated, even with sequence numbers rewritten', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb(1), fc.nat(), fc.boolean(), async (ops, pick, rewrite) => {
        const proof = await buildSession(ops);
        const events = proof.proof.events;
        const index = pick % events.length;
        events.splice(index + 1, 0, structuredClone(events[index] as StoredEvent));
        if (rewrite) renumber(events);

        expect((await verifyFast(proof)).valid).toBe(false);
      }),
      FC_PARAMS
    );
  });

  // ----- previousHash の照合を縛る性質と、その偽造器の対照 -----
  // 上の改ざんは sequence・timestamp・hash の再計算でも落ちるので、previousHash の照合を外しても緑のまま。
  // 照合が効いていることは「previousHash だけが嘘で、hash はすべて正しく振り直された」proof でしか
  // 確かめられない。偽造器 (`rechainFrom`) が壊れていると性質は照合と無関係に緑になるので、対照を 2 つ置く。

  it('keeps an untouched proof valid after the test forger recomputes every hash from any event', async () => {
    // 対照 1: 偽造器が検証器と同じ式で hash を計算している
    await fc.assert(
      fc.asyncProperty(sessionArb(1), fc.nat(), async (ops, pick) => {
        const proof = await buildSession(ops);
        await rechainFrom(proof, pick % proof.proof.events.length);

        const result = await verifyFast(proof);

        expect(result.valid, result.errorMessage).toBe(true);
      }),
      FC_PARAMS
    );
  });

  it('leaves the forged previousHash as the only defect the verifier finds after the test forger relinks the chain', async () => {
    // 対照 2: 偽造器が最終ハッシュ・typingProofHash・checkpoint まで合わせ、嘘の previousHash 以外に綻びを残さない
    await fc.assert(
      fc.asyncProperty(sessionArb(2), fc.nat(), hex64Arb, async (ops, pick, forgedPreviousHash) => {
        const proof = await buildSession(ops);
        // 先頭は root の照合が別に止めるので、照合の対象になる 2 番目以降を選ぶ
        const index = 1 + (pick % (proof.proof.events.length - 1));
        fc.pre(await forgePreviousHash(proof, index, forgedPreviousHash));

        expect(await verifyFast(proof)).toMatchObject({
          metadataValid: true,
          checkpointValid: true,
          contentValid: true,
          errorAt: index,
          errorMessage: `Previous hash mismatch at event ${index}`,
        });
      }),
      FC_PARAMS
    );
  });

  it('rejects an event whose previousHash does not name its predecessor even when every hash after it is recomputed', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArb(1), fc.nat(), hex64Arb, async (ops, pick, forgedPreviousHash) => {
        const proof = await buildSession(ops);
        fc.pre(await forgePreviousHash(proof, pick % proof.proof.events.length, forgedPreviousHash));

        expect((await verifyFast(proof)).valid).toBe(false);
      }),
      FC_PARAMS
    );
  });
});
