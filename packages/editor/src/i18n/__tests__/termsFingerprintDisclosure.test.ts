/**
 * 利用規約の「ブラウザフィンガープリント」の列挙が、実際に集める項目と食い違わないことの検査 (#242)
 *
 * `Fingerprint.collectComponents()` が集めるキー (`CollectedFingerprintComponents`) ごとに、
 * 規約での言い方を DISCLOSURE に持つ。キーを足す・消すと `Record<keyof ...>` の型が合わなくなり
 * `npm run typecheck` で気付く (ADR-0044)。各句が ja / en の `terms.hashChainFingerprint` に
 * 含まれることを確かめ、index.html の静的な同文 (JS が走る前に見える ja の文) が ja の値と
 * ずれていないことも確かめる。
 */

import { readFileSync } from 'node:fs';
import type { CollectedFingerprintComponents } from '@typedcode/shared';
import { describe, expect, it } from 'vitest';
import { en } from '../translations/en';
import { ja } from '../translations/ja';

const DISCLOSURE: Record<keyof CollectedFingerprintComponents, { ja: string; en: string }> = {
  userAgent: { ja: 'ユーザーエージェント', en: 'user agent' },
  language: { ja: '言語設定', en: 'language settings' },
  languages: { ja: '優先言語の一覧', en: 'list of preferred languages' },
  platform: { ja: 'プラットフォーム', en: 'platform' },
  hardwareConcurrency: { ja: 'CPU コア数', en: 'number of CPU cores' },
  deviceMemory: { ja: 'メモリ量', en: 'device memory' },
  screen: { ja: '画面（解像度・色深度・表示倍率）', en: 'screen (resolution, color depth, pixel ratio)' },
  timezone: { ja: 'タイムゾーン', en: 'timezone' },
  timezoneOffset: { ja: 'UTC との時差', en: 'UTC offset' },
  webgl: { ja: 'GPU のベンダー名とレンダラー名', en: 'GPU vendor and renderer names' },
  cookieEnabled: { ja: 'Cookie の有効・無効', en: 'whether cookies are enabled' },
  doNotTrack: { ja: 'Do Not Track の設定', en: 'Do Not Track setting' },
  maxTouchPoints: { ja: 'タッチ点数', en: 'number of touch points' },
};

/** index.html から data-i18n="<key>" の要素の静的テキストを取り出す */
function staticTextOf(html: string, key: string): string | undefined {
  const escaped = key.replace(/\./g, '\\.');
  return html.match(new RegExp(`data-i18n="${escaped}">([^<]*)<`))?.[1];
}

const indexHtml = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');

describe('terms fingerprint disclosure', () => {
  it.each(Object.entries(DISCLOSURE))('the ja terms name the collected component %s', (_key, phrase) => {
    expect(ja.terms.hashChainFingerprint).toContain(phrase.ja);
  });

  it.each(Object.entries(DISCLOSURE))('the en terms name the collected component %s', (_key, phrase) => {
    expect(en.terms.hashChainFingerprint).toContain(phrase.en);
  });

  it.each(['terms.hashChainFingerprint', 'terms.privacyBrowserInfo'] as const)(
    'the static text of %s in index.html matches the ja translation',
    (key) => {
      const [, field] = key.split('.') as ['terms', 'hashChainFingerprint' | 'privacyBrowserInfo'];
      expect(staticTextOf(indexHtml, key)).toBe(ja.terms[field]);
    }
  );
});
