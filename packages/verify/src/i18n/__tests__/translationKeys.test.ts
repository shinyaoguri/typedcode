/**
 * verify の ja / en 翻訳のキー集合の一致 (#728)
 *
 * `VerifyTranslationKeys` の型は入れ子のキーの欠落・余分を `npm run typecheck` で捕まえるが、型の先頭に
 * 動的アクセス用の索引シグネチャ (`[key: string]: unknown`) があるため、**片方の言語にだけある最上位の
 * 名前空間**は型を通ってしまう。また型は値が空文字であることを止めない (画面に何も出ない)。
 * ここではその 2 つの穴を、ネストを平坦化したキー集合と葉の値で検査する。文言そのものは比べない。
 */

import { describe, expect, it } from 'vitest';
import { en } from '../translations/en';
import { ja } from '../translations/ja';

/** 入れ子の翻訳オブジェクトを `a.b.c` 形式のキーと葉の値の組に平坦化する。 */
function flatten(tree: unknown, prefix = ''): Array<[string, unknown]> {
  if (tree === null || typeof tree !== 'object') return [[prefix, tree]];
  return Object.entries(tree).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

const locales = { ja, en };

describe('verify translations', () => {
  it('ja and en define exactly the same set of flattened keys', () => {
    const jaKeys = new Set(flatten(ja).map(([k]) => k));
    const enKeys = new Set(flatten(en).map(([k]) => k));
    expect(
      [...jaKeys].filter((k) => !enKeys.has(k)),
      'keys only in ja'
    ).toEqual([]);
    expect(
      [...enKeys].filter((k) => !jaKeys.has(k)),
      'keys only in en'
    ).toEqual([]);
  });

  it.each(Object.entries(locales))('every %s leaf is a non-empty string', (_locale, tree) => {
    const bad = flatten(tree)
      .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
