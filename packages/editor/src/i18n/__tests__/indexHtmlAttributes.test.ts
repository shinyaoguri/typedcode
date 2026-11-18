// @vitest-environment happy-dom
/**
 * index.html の静的な属性の翻訳 (#736 / #739)
 *
 * 名前 (`aria-label`) を `data-i18n-aria` で、ツールチップ (`title`) を `data-i18n-title` で翻訳する要素が、
 * 表示言語の訳を持つことを確かめる。index.html の本文をそのまま読み、`updateDOMTranslations`
 * (shared の `createDOMUpdater`) を ja / en で当てる。`title` を翻訳せずに足すと、ja の UI でも英語のまま
 * ツールチップと読み上げに出る (#739) ので、`data-i18n-title` の無い `title` が無いことも見る。
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

/** `a.b` 形式のキーを翻訳の辞書から引く (無ければ undefined) */
function lookup(tree: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      tree
    );
}

/** #739 で翻訳するようにした title (要素とキー) */
const TRANSLATED_TITLES = [
  ['#preview-iframe', 'preview.title'],
  ['#proof-status-item', 'statusBar.proofStatusTitle'],
  ['#event-count-item', 'statusBar.eventCountTitle'],
  ['#hash-status-item', 'statusBar.hashTitle'],
  ['#sync-status-item', 'statusBar.syncTitle'],
  ['#language-status', 'statusBar.selectLanguage'],
  ['#cursor-position', 'statusBar.cursorPositionTitle'],
] as const;

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

  it('every title in index.html is translated through data-i18n-title', () => {
    document.body.innerHTML = indexBody;
    const untranslated = [...document.querySelectorAll('[title]:not([data-i18n-title])')].map(
      (el) => `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''} title="${el.getAttribute('title')}">`
    );
    expect(untranslated).toEqual([]);
  });

  it.each(['ja', 'en'] as const)(
    'every data-i18n-title and data-i18n-aria key in index.html exists in %s',
    (locale) => {
      document.body.innerHTML = indexBody;
      const keys = [...document.querySelectorAll('[data-i18n-title], [data-i18n-aria]')].flatMap((el) =>
        [el.getAttribute('data-i18n-title'), el.getAttribute('data-i18n-aria')].filter((k): k is string => k !== null)
      );
      expect(keys.filter((key) => typeof lookup(dictionaries[locale], key) !== 'string')).toEqual([]);
    }
  );

  it.each(
    (['ja', 'en'] as const).flatMap((locale) =>
      TRANSLATED_TITLES.map(([selector, key]) => [locale, selector, key] as const)
    )
  )('in the %s display language the title of %s is the translation of %s', (locale, selector, key) => {
    renderIn(locale);
    expect(document.querySelector(selector)?.getAttribute('title')).toBe(lookup(dictionaries[locale], key));
  });
});
