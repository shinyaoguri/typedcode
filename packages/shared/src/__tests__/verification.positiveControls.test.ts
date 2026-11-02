/**
 * verification の正の対照テスト (#502)
 *
 * 変異検査 (#467) で「判定を厳しくする向き (正規の proof を誤って拒否する向き)」の変異が
 * 生き残った 3 箇所を固定する。どれも壊しても既存テストは緑のままで、壊れると正規に提出された
 * proof が検証で落ちる (学生の提出物が無効と表示される)。
 *
 * - `verifyChain` の timestamp 単調性 (同値は許し、減少だけを拒否する)
 * - `verifyContentReplay` の置換・削除 (`rangeLength > 0`) の適用
 * - `verifyContentReplay` の templateInjection / contentSnapshot による文書の置き換えと、その後の contentChange
 *
 * 各正常系には、最終内容を 1 文字変えると落ちる負の対照を添える (テストが常に緑ではないことを示す)。
 * 仕様は変えない。今の判定が正規の列を通すことを確かめるだけ。
 */

import { describe, expect, it } from 'vitest';
import { POSW_ITERATIONS, computeHash, deterministicStringify, verifyChain, verifyContentReplay } from '../index.js';
import { pickHashedEventFields } from '../verification.js';
import type { EventHashData, StoredEvent } from '../types.js';

const REPLAY_MISMATCH = 'Replayed content does not match exported final content';

/**
 * 指定した timestamp を持つ、hash 連鎖が正しい events を組み立てる。
 *
 * 実際の recorder (`TypingProof.recordEvent`) は同値の timestamp を 0.001ms 進めて単調増加にするので、
 * 同値を含む列は recorder 経由では作れない。verifier は同値を許す側に倒れていることを確かめたいので、
 * `verifyChain` と同じ式 (`pickHashedEventFields` → `deterministicStringify` → `computeHash`) で手組みする。
 * 先頭イベントの previousHash は null で、`verifyChain` は文字列連結で "null" として扱うので `String()` で合わせる。
 * PoSW の反復は `skipPosw` で再計算させないので、`posw` は iterations だけ合わせた偽データでよい。
 */
async function buildChain(timestamps: number[]): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  let previousHash: string | null = null;

  for (let i = 0; i < timestamps.length; i++) {
    const posw = {
      iterations: POSW_ITERATIONS,
      nonce: '0'.repeat(16),
      intermediateHash: '0'.repeat(64),
      computeTimeMs: 1,
    };
    const base = {
      sequence: i,
      timestamp: timestamps[i] as number,
      type: 'contentChange',
      inputType: 'insertText',
      data: 'a',
      rangeOffset: i,
      rangeLength: 0,
      range: null,
      previousHash,
    } as const;
    const hashData: EventHashData = { ...pickHashedEventFields({ ...base, posw }), posw };
    const hash = await computeHash(String(previousHash) + deterministicStringify(hashData));
    events.push({ ...base, posw, hash } as StoredEvent);
    previousHash = hash;
  }

  return events;
}

/** replay に必要なフィールドだけを持つ最小の contentChange (既存の replay テストと同じ形) */
const change = (data: string, rangeOffset: number, rangeLength: number): StoredEvent =>
  ({
    type: 'contentChange',
    inputType: 'insertText',
    data,
    rangeOffset,
    rangeLength,
  }) as StoredEvent;

const templateInjection = (content: string): StoredEvent =>
  ({ type: 'templateInjection', data: { content } }) as StoredEvent;

const contentSnapshot = (content: string): StoredEvent => ({ type: 'contentSnapshot', data: content }) as StoredEvent;

describe('verifyChain: timestamp の単調性 (verification.ts の `event.timestamp < lastTimestamp`)', () => {
  it('同じ timestamp が連続する正規のチェーンを通す', async () => {
    const events = await buildChain([10, 10, 11]);

    await expect(verifyChain(events, undefined, { skipPosw: true })).resolves.toMatchObject({ valid: true });
  });

  it('負の対照: timestamp が減少するチェーンは Timestamp violation で拒否する', async () => {
    const events = await buildChain([10, 9, 11]);

    await expect(verifyChain(events, undefined, { skipPosw: true })).resolves.toMatchObject({
      valid: false,
      errorAt: 1,
      message: 'Timestamp violation at event 1',
    });
  });
});

describe('verifyContentReplay: 置換・削除 (rangeLength > 0)', () => {
  const typeAbc = [change('a', 0, 0), change('b', 1, 0), change('c', 2, 0)];

  it('abc の 1 文字目以降 1 文字を X で置換した列は最終内容 aXc で通る', () => {
    const events = [...typeAbc, change('X', 1, 1)];

    expect(verifyContentReplay(events, 'aXc')).toMatchObject({ valid: true, reconstructedContent: 'aXc' });
  });

  it('abc の先頭 2 文字を削除した列は最終内容 c で通る', () => {
    const events = [...typeAbc, change('', 0, 2)];

    expect(verifyContentReplay(events, 'c')).toMatchObject({ valid: true, reconstructedContent: 'c' });
  });

  it('負の対照: 最終内容が 1 文字違うと不一致で拒否する', () => {
    expect(verifyContentReplay([...typeAbc, change('X', 1, 1)], 'aYc')).toMatchObject({
      valid: false,
      reason: REPLAY_MISMATCH,
    });
    expect(verifyContentReplay([...typeAbc, change('', 0, 2)], 'b')).toMatchObject({
      valid: false,
      reason: REPLAY_MISMATCH,
    });
  });
});

describe('verifyContentReplay: templateInjection / contentSnapshot による文書の置き換え', () => {
  it('templateInjection の後に末尾へ \\n を足す contentChange が続く列は通る', () => {
    const events = [templateInjection('int main(){}'), change('\n', 12, 0)];

    expect(verifyContentReplay(events, 'int main(){}\n')).toMatchObject({
      valid: true,
      reconstructedContent: 'int main(){}\n',
    });
  });

  it('contentSnapshot の後に末尾へ ! を足す contentChange が続く列は通る', () => {
    const events = [contentSnapshot('hello'), change('!', 5, 0)];

    expect(verifyContentReplay(events, 'hello!')).toMatchObject({ valid: true, reconstructedContent: 'hello!' });
  });

  it('負の対照: 最終内容が 1 文字違うと不一致で拒否する', () => {
    expect(
      verifyContentReplay([templateInjection('int main(){}'), change('\n', 12, 0)], 'int main(){} ')
    ).toMatchObject({ valid: false, reason: REPLAY_MISMATCH });
    expect(verifyContentReplay([contentSnapshot('hello'), change('!', 5, 0)], 'hello?')).toMatchObject({
      valid: false,
      reason: REPLAY_MISMATCH,
    });
  });
});
