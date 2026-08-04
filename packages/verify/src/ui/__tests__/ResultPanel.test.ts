/**
 * ResultPanel の三層保証バッジ列 (ADR-0020) を組み立てる純関数のテスト。
 *
 * ここで返る文字列は `#assurance-strip` の innerHTML にそのまま入る。proof.json 由来の
 * 値 (自己申告 mode) が未エスケープで混ざると、検証ツール自身が乗っ取られて
 * 「検証失敗」を「検証成功」に見せられる (#210)。エスケープを仕様として固定する。
 */

import { describe, expect, it } from 'vitest';
import { escapeHtml, type AssuranceResult } from '@typedcode/shared';
import { buildAssuranceStripHtml, type ResultData } from '../ResultPanel.js';

/** 健全な anchored proof の保証導出結果。 */
function assurance(): AssuranceResult {
  return {
    integrity: 'proven',
    temporal: 'anchored',
    provenance: { pureTyping: true, notableSignals: 0, reviewPriority: 0 },
  };
}

/**
 * 実行時の `mode` は `JSON.parse` の結果を union に cast しただけなので任意文字列が入りうる。
 * 型では表現できない実行時の現実を再現するためのキャスト。
 */
function asMode(raw: string): ResultData['mode'] {
  return raw as ResultData['mode'];
}

describe('buildAssuranceStripHtml', () => {
  it('escapes a malicious mode so no element is injected into the assurance strip', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = buildAssuranceStripHtml(assurance(), asMode(payload));

    expect(html).not.toContain(payload);
    expect(html).not.toContain('<img');
    expect(html).toContain(escapeHtml(payload));
  });

  it('escapes a mode that would break out of the chip attribute quoting', () => {
    const payload = '" onmouseover="alert(1)';
    const html = buildAssuranceStripHtml(assurance(), asMode(payload));

    expect(html).not.toContain(payload);
    expect(html).toContain(escapeHtml(payload));
  });

  it('renders the localized label for a known mode', () => {
    const html = buildAssuranceStripHtml(assurance(), 'exam');

    // i18n キーがそのまま漏れていないこと (未登録キーは t() がキー文字列を返すため)
    expect(html).not.toContain('assurance.mode.exam');
    expect(html).toContain('assurance-chip-value');
  });

  it('omits the mode chip entirely when no mode is given', () => {
    const html = buildAssuranceStripHtml(assurance(), undefined);

    expect(html).not.toContain('assurance-chip neutral');
  });

  it('still renders the three deterministic chips', () => {
    const html = buildAssuranceStripHtml(assurance(), 'casual');

    expect(html).toContain('assurance-chip success');
    expect(html).toContain('assurance-chip advisory');
  });
});
