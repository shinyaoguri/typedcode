// @vitest-environment happy-dom
/**
 * IdleTimeoutManager のタブタイトル点滅の翻訳 (#784)
 *
 * 警告中の `document.title` が表示言語の文言と元のタイトルの間で切り替わること、
 * ソースに利用者へ見える日本語の固定文字列が残っていないことを確かめる。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupportedLocale } from '@typedcode/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getI18n } from '../../i18n/index';
import { en } from '../../i18n/translations/en';
import { ja } from '../../i18n/translations/ja';
import { IdleTimeoutManager } from '../IdleTimeoutManager';

const JAPANESE = /[぀-ヿ㐀-鿿]/;
const ORIGINAL_TITLE = 'TypedCode';

/** 警告ダイアログが開いたままの状態にして、点滅の 1 周期ぶん (1 秒ずつ) の title を集める */
function collectTitles(locale: SupportedLocale): string[] {
  getI18n().setLocale(locale);
  document.title = ORIGINAL_TITLE;
  const manager = new IdleTimeoutManager({ idleTimeoutMs: 1000 });
  manager.setUICallbacks({
    showWarningDialog: () => new Promise<boolean>(() => {}),
    showSuspendedOverlay: () => {},
    hideSuspendedOverlay: () => {},
  });
  manager.handleFocusLost();
  vi.advanceTimersByTime(1000); // idle タイマー発火 -> warning + 点滅開始
  expect(manager.getState()).toBe('warning');
  const titles: string[] = [];
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(1000);
    titles.push(document.title);
  }
  manager.dispose();
  return titles;
}

describe('IdleTimeoutManager title flash during the idle warning (#784)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    getI18n().setLocale('ja');
  });

  it('alternates the English flash text and the original title when the locale is en', () => {
    expect(collectTitles('en')).toEqual([
      en.idleTimeout.titleFlash,
      ORIGINAL_TITLE,
      en.idleTimeout.titleFlash,
      ORIGINAL_TITLE,
    ]);
  });

  it('alternates the Japanese flash text and the original title when the locale is ja', () => {
    expect(collectTitles('ja')).toEqual([
      ja.idleTimeout.titleFlash,
      ORIGINAL_TITLE,
      ja.idleTimeout.titleFlash,
      ORIGINAL_TITLE,
    ]);
  });

  it('keeps Japanese characters out of the en flash text and in the ja flash text', () => {
    expect(en.idleTimeout.titleFlash).not.toMatch(JAPANESE);
    expect(ja.idleTimeout.titleFlash).toMatch(JAPANESE);
  });
});

describe('IdleTimeoutManager.ts source (#784)', () => {
  it('has no hard-coded Japanese text outside comments and console.* log lines', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../IdleTimeoutManager.ts'), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .filter((line) => !line.includes('console.'))
      .join('\n');
    expect(code).not.toMatch(JAPANESE);
  });
});
