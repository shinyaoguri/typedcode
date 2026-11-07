/**
 * チャートのイベント選択 (ChartEventSelector) のラベル (#640)。
 *
 * ChartEventSelector は `charts.events.<EventType>` を引いて表示する。訳が無い種別は
 * `t()` がキー文字列をそのまま返すので、画面に `charts.events.fullscreenChange` のような
 * 生キーが出る。チャートに出る種別 (EVENT_CATEGORIES) すべてに ja / en の訳があることを固定する。
 */

import { describe, expect, it } from 'vitest';
import { en } from '../../i18n/translations/en.js';
import { ja } from '../../i18n/translations/ja.js';
import { EVENT_CATEGORIES } from '../../types/chartVisibility.js';

const chartEventTypes = EVENT_CATEGORIES.flatMap((category) => category.events);

describe('charts.events の訳 (#640)', () => {
  it('チャートに出るイベント種別が 1 つ以上ある', () => {
    expect(chartEventTypes.length).toBeGreaterThan(0);
  });

  for (const [locale, translations] of [
    ['ja', ja],
    ['en', en],
  ] as const) {
    it(`${locale}: チャートに出る全イベント種別に空でない訳がある`, () => {
      const events = translations.charts.events as Record<string, string | undefined>;
      const missing = chartEventTypes.filter((type) => !events[type]);
      expect(missing).toEqual([]);
    });
  }
});
