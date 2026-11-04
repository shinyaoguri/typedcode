/**
 * 復元した content とチェーンの replay の突き合わせ (#413 / #142)。
 *
 * PoSW の処理待ちが残ったまま閉じると、打鍵はチェーンに載らないのに content にだけ残る。
 * バッファは replay 版にして proof を valid に保ち、元の content は捨てずに `divergence` で返す。
 * replay が途中で失敗するとき (深い破損) は、content を変えずに理由だけ返す。
 */

import { describe, it, expect } from 'vitest';
import type { StoredEvent } from '@typedcode/shared';
import { reconcileRestoredContent } from '../restoredContent.js';

/** replay が読むフィールドだけを持つ contentChange (hash などは replay に関係しない) */
function change(sequence: number, rangeOffset: number, data: string, rangeLength = 0): StoredEvent {
  return {
    sequence,
    timestamp: sequence * 10,
    type: 'contentChange',
    inputType: rangeLength > 0 && data === '' ? 'deleteContentBackward' : 'insertText',
    data,
    rangeOffset,
    rangeLength,
    range: null,
    previousHash: null,
    posw: { iterations: 1, nonce: 'n', intermediateHash: 'm', computeTimeMs: 1 },
    hash: `hash-${sequence}`,
    description: null,
    isMultiLine: null,
    deletedLength: null,
    insertedText: null,
    insertLength: null,
    deleteDirection: null,
    selectedText: null,
  };
}

/** "abc" を 1 文字ずつ打った記録 */
const typedAbc: StoredEvent[] = [change(0, 0, 'a'), change(1, 1, 'b'), change(2, 2, 'c')];

describe('reconcileRestoredContent', () => {
  it('keeps content that matches the chain replay and reports no divergence', () => {
    const result = reconcileRestoredContent('abc', typedAbc);

    expect(result).toEqual({ content: 'abc', divergence: null });
  });

  it('returns the chain replay as the content when the saved content ran ahead of the chain', () => {
    const result = reconcileRestoredContent('abcdef', typedAbc);

    expect(result.content).toBe('abc');
  });

  it('hands back the whole original content as the divergence when it truncates', () => {
    const result = reconcileRestoredContent('abcdef', typedAbc);

    expect(result.divergence).toEqual({ original: 'abcdef', chainContent: 'abc' });
  });

  it('reports a divergence when the unproven edit was a deletion and the original is shorter than the chain', () => {
    // 処理待ちが削除だと、元の content のほうが短い (差分は末尾の追記に限らない)
    const result = reconcileRestoredContent('ac', typedAbc);

    expect(result).toEqual({ content: 'abc', divergence: { original: 'ac', chainContent: 'abc' } });
  });

  it('leaves the content untouched and reports why when the replay itself fails (deeper corruption)', () => {
    // 範囲外の contentChange は replay を途中で止める。再構成した版が無いので、どちらも捨てない
    const broken = [change(0, 0, 'a'), change(1, 5, 'x')];

    const result = reconcileRestoredContent('ax', broken);

    expect(result.content).toBe('ax');
    expect(result.divergence).toBeNull();
    expect(result.replayError).toMatch(/out of bounds at event 1/);
  });

  it('keeps the content as is when there are no events to reconcile against', () => {
    const result = reconcileRestoredContent('anything', []);

    expect(result).toEqual({ content: 'anything', divergence: null });
  });
});
