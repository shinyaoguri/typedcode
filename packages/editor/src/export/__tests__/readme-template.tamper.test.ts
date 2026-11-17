/**
 * export ZIP の README の改ざん検出の範囲の固定 (#677)。
 *
 * 検証器が検出するのはハッシュ・署名の対象の書き換えで、対象外のフィールド (イベントの description など) の
 * 書き換えは検出しない。「1 ビットでも変えると失敗」のような、対象外まで含む全部の書き換えを検出すると
 * 読める説明が戻らないことを確かめる。
 */

import { describe, it, expect } from 'vitest';
import { generateReadmeJa } from '../readme-template-ja.js';
import { generateReadmeEn } from '../readme-template-en.js';

const params = {
  timestamp: '2026-01-01T00:00:00.000Z',
  totalFiles: 1,
  totalScreenshots: 0,
  sourceFiles: ['main.ts'],
  proofFiles: ['proof.json'],
};

describe('README の改ざん検出の範囲', () => {
  it('ja: 全部の書き換えを検出すると読める書き方をせず、ハッシュ対象外は検出しないと書く', () => {
    const readme = generateReadmeJa(params);
    expect(readme).not.toContain('1 ビットでも');
    expect(readme).toContain('ハッシュ対象外のフィールドの書き換えは検出しない');
  });

  it('en: does not claim every change is detected and says fields outside the hash are not covered', () => {
    const readme = generateReadmeEn(params);
    expect(readme).not.toContain('any change to the recorded events');
    expect(readme).toContain('fields outside the hash');
  });
});
