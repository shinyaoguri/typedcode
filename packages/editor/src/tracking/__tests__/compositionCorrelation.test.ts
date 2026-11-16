/**
 * composition と編集の対応付け (#720) の純関数のテスト。
 *
 * 変更の列は Chromium + Monaco 0.57 (EditContext 経路) で CDP の `Input.imeSetComposition` /
 * `Input.insertText` を流して観測した形に合わせてある (preedit は 1 文字ずつ、または置換で伸びる。
 * 確定は preedit の範囲を置き換える 1 件)。CDP の合成 composition は実 IME の代わりではない。
 */

import { describe, expect, it } from 'vitest';
import {
  type CompositionAttribution,
  type CompositionState,
  type CorrelatedChange,
  IDLE_COMPOSITION,
  correlateChange,
  endComposition,
  settleComposition,
  startComposition,
} from '../compositionCorrelation.js';

const MODEL = 'model-1';

function change(rangeOffset: number, rangeLength: number, text: string): CorrelatedChange {
  return { rangeOffset, rangeLength, text };
}

/** 状態に change の列を順に流し、各帰属と最後の状態を返す。 */
function run(
  state: CompositionState,
  changes: CorrelatedChange[],
  modelKey = MODEL
): { attributions: CompositionAttribution[]; state: CompositionState } {
  const attributions: CompositionAttribution[] = [];
  let current = state;
  for (const c of changes) {
    const result = correlateChange(current, modelKey, c);
    attributions.push(result.attribution);
    current = result.state;
  }
  return { attributions, state: current };
}

/** キャレット (offset 3) で始めた composition。 */
const atCaret = () => startComposition(MODEL, { start: 3, end: 3 });

describe('correlateChange (#720)', () => {
  it('attributes nothing while idle', () => {
    expect(run(IDLE_COMPOSITION, [change(3, 0, 'に')]).attributions).toEqual(['none']);
  });

  it('attributes an insert at the caret where the composition started', () => {
    expect(run(atCaret(), [change(3, 0, 'に')]).attributions).toEqual(['composing']);
  });

  it('follows a preedit that grows character by character and is then converted (hiragana to kanji)', () => {
    const { attributions, state } = run(atCaret(), [
      change(3, 0, 'に'),
      change(4, 0, 'ほ'),
      change(5, 0, 'ん'),
      change(3, 3, '日本'),
    ]);

    expect(attributions).toEqual(['composing', 'composing', 'composing', 'composing']);
    expect(state).toEqual({ phase: 'composing', modelKey: MODEL, region: { start: 3, end: 5 } });
  });

  it('follows a Hangul syllable that is recomposed in place', () => {
    const { attributions } = run(atCaret(), [change(3, 0, 'ㅎ'), change(3, 1, '하'), change(3, 1, '한')]);

    expect(attributions).toEqual(['composing', 'composing', 'composing']);
  });

  it('follows a pinyin preedit that is replaced by hanzi of a different length', () => {
    const { attributions, state } = run(atCaret(), [
      change(3, 0, 'zhong'),
      change(3, 5, 'zhongwen'),
      change(3, 8, '中文'),
    ]);

    expect(attributions).toEqual(['composing', 'composing', 'composing']);
    expect(state).toMatchObject({ region: { start: 3, end: 5 } });
  });

  it('attributes a reconversion that replaces the text selected when the composition started', () => {
    const reconversion = startComposition(MODEL, { start: 370, end: 368 });

    expect(run(reconversion, [change(368, 2, 'か'), change(369, 0, 'ん'), change(368, 2, '漢')]).attributions).toEqual([
      'composing',
      'composing',
      'composing',
    ]);
  });

  it('attributes an edit adjacent to the region that replaces existing text before the caret', () => {
    // 再変換: キャレット (offset 3) の前の 2 文字を置き換える
    expect(run(atCaret(), [change(1, 2, 'へんかん')]).attributions).toEqual(['composing']);
  });

  it('attributes the deletion that cancels the preedit', () => {
    const { attributions, state } = run(atCaret(), [change(3, 0, 'あ'), change(4, 0, 'い'), change(3, 2, '')]);

    expect(attributions).toEqual(['composing', 'composing', 'composing']);
    expect(state).toMatchObject({ region: { start: 3, end: 3 } });
  });

  it('does not attribute an edit away from the composition region', () => {
    expect(run(atCaret(), [change(3, 0, 'に'), change(40, 0, 'int x = 1;')]).attributions).toEqual([
      'composing',
      'none',
    ]);
  });

  it('shifts the region by an unrelated edit before it so later preedit updates still correlate', () => {
    const { attributions, state } = run(atCaret(), [change(3, 0, 'に'), change(0, 1, ''), change(2, 1, 'にほ')]);

    expect(attributions).toEqual(['composing', 'none', 'composing']);
    expect(state).toMatchObject({ region: { start: 2, end: 4 } });
  });

  it('does not attribute an edit in a different model', () => {
    expect(run(atCaret(), [change(3, 0, 'に')], 'model-2').attributions).toEqual(['none']);
  });

  it('attributes only the first correlated edit after the composition ended as committed', () => {
    const composed = run(atCaret(), [change(3, 0, 'にほん')]).state;
    const { attributions, state } = run(endComposition(composed), [change(3, 3, '日本'), change(5, 0, 'int main(){}')]);

    expect(attributions).toEqual(['committed', 'none']);
    expect(state).toBe(IDLE_COMPOSITION);
  });

  it('keeps settling across an unrelated edit and commits the correlated one after it', () => {
    const composed = run(atCaret(), [change(3, 0, 'にほん')]).state;

    expect(run(endComposition(composed), [change(40, 0, 'x'), change(3, 3, '日本')]).attributions).toEqual([
      'none',
      'committed',
    ]);
  });

  it('closes settling without any edit when settled', () => {
    const settling = endComposition(run(atCaret(), [change(3, 0, 'にほん')]).state);
    const settled = settleComposition(settling);

    expect(settled).toBe(IDLE_COMPOSITION);
    expect(run(settled, [change(3, 3, '日本')]).attributions).toEqual(['none']);
  });

  it('does not carry the previous region into the next composition', () => {
    const first = endComposition(run(atCaret(), [change(3, 0, 'にほん')]).state);
    const second = startComposition(MODEL, { start: 50, end: 50 });

    expect(first.phase).toBe('settling');
    expect(run(second, [change(3, 3, '日本')]).attributions).toEqual(['none']);
  });

  it('leaves idle and composing unchanged on settle, and idle unchanged on end', () => {
    expect(settleComposition(atCaret())).toEqual(atCaret());
    expect(endComposition(IDLE_COMPOSITION)).toBe(IDLE_COMPOSITION);
  });
});
