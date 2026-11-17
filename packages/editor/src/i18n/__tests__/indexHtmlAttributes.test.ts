// @vitest-environment happy-dom
/**
 * index.html の静的な属性の翻訳 (#736)
 *
 * 名前 (`aria-label`) を `data-i18n-aria` で翻訳する要素が、表示言語の訳で名前を持つことを確かめる。
 * index.html の本文をそのまま読み、`updateDOMTranslations` (shared の `createDOMUpdater`) を ja / en で当てる。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupportedLocale } from '@typedcode/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { getI18n, updateDOMTranslations } from '../index';
import { en } from '../translations/en';
import { ja } from '../translations/ja';

// happy-dom の環境では URL が happy-dom のものになり file: を readFileSync に渡せないので、パスに直して読む
const indexHtml = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../index.html'), 'utf8');
/** body の中身。script は読まない (happy-dom はモジュールの読み込みを無効にしていて、読もうとすると例外を出す) */
const indexBody = (indexHtml.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? '').replace(
  /<script[\s\S]*?<\/script>/g,
  ''
);
const dictionaries = { ja, en } as const;

/** index.html の body を読み込み、指定の表示言語で属性を翻訳する */
function renderIn(locale: SupportedLocale): void {
  document.body.innerHTML = indexBody;
  getI18n().setLocale(locale);
  updateDOMTranslations();
}

describe('index.html attribute translations', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['ja', 'en'] as const)('the language selector is named in the %s display language', (locale) => {
    renderIn(locale);
    expect(document.getElementById('language-selector')?.getAttribute('aria-label')).toBe(
      dictionaries[locale].statusBar.selectLanguage
    );
  });
});
