/**
 * About に出す版の表記 `formatAppVersion` (#842) のテスト。
 *
 * 版はビルドに渡したタグ名から決まる (scripts/app-version.mjs)。数字で始まる版にだけ `v` を付け、
 * タグでないビルドの `dev+<コミット>` / `dev` に `v` を付けて `vdev` と見せない。
 */

import { describe, expect, it } from 'vitest';
import { formatAppVersion } from '../index.js';

describe('formatAppVersion', () => {
  it.each([
    ['2027.2.0-beta.3', 'v2027.2.0-beta.3'],
    ['1.5.0', 'v1.5.0'],
  ])('prefixes a released version %s with v', (input, expected) => {
    expect(formatAppVersion(input)).toBe(expected);
  });

  it.each(['dev+abc1234', 'dev'])('leaves a non-tag build version %s unchanged', (input) => {
    expect(formatAppVersion(input)).toBe(input);
  });
});
