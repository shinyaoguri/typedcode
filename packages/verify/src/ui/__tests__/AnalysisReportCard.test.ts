// @vitest-environment happy-dom
/**
 * 分析カード (ADR-0009) の signal の表示。
 *
 * #416: templateInjection の文字数 signal は `summaryKey` で翻訳されて出る。key が ja / en のどちらかに
 * 無いと、`t()` がキー文字列を返して summary (英語の素の文) に落ちるので、ロケールごとに両方の数が
 * 読めることを実際の翻訳で固定する。
 */

import { runAnalysis } from '@typedcode/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getI18n } from '../../i18n/index.js';
import { AnalysisReportCard } from '../AnalysisReportCard.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

async function templateInjectionReport() {
  const events = [
    {
      type: 'templateInjection',
      timestamp: 0,
      data: { templateName: 't', filename: 'main.c', content: 'x'.repeat(500), contentLength: 0 },
    },
    { type: 'contentChange', timestamp: 1000, data: 'y'.repeat(10), inputType: 'insertText' },
  ];
  return runAnalysis({
    proof: { proof: { events } } as never,
    verification: { valid: true, metadataValid: true, chainValid: true, isPureTyping: true } as never,
  });
}

function renderedSummaries(): string[] {
  return [...document.querySelectorAll('#analysis-content .analysis-summary')].map((el) => el.textContent ?? '');
}

beforeEach(() => {
  mountVerifyIndexHtml();
});

describe('AnalysisReportCard: template injection signal', () => {
  it('shows the template and typed character counts in Japanese', async () => {
    getI18n().setLocale('ja');
    new AnalysisReportCard().render(await templateInjectionReport());
    const summary = renderedSummaries().find((s) => s.includes('テンプレート'));
    expect(summary).toBe('テンプレートで入った文字数 500 / 打った文字数 10');
  });

  it('shows the template and typed character counts in English', async () => {
    getI18n().setLocale('en');
    new AnalysisReportCard().render(await templateInjectionReport());
    const summary = renderedSummaries().find((s) => s.includes('Template'));
    expect(summary).toBe('Template-injected content: 500 chars from templates, 10 chars typed');
  });

  it('resolves the signal summaryKey in both locales, not through the summary fallback', async () => {
    const [signal] = (await templateInjectionReport()).signals.filter((s) => s.analyzerId === 'template-injection');
    const key = signal?.summaryKey ?? '';
    for (const locale of ['ja', 'en'] as const) {
      getI18n().setLocale(locale);
      expect(getI18n().t(key, signal?.summaryParams)).not.toBe(key);
    }
  });

  it('renders the signal as an INFO row', async () => {
    getI18n().setLocale('en');
    new AnalysisReportCard().render(await templateInjectionReport());
    const row = [...document.querySelectorAll('#analysis-content .analysis-signal')].find((el) =>
      el.textContent?.includes('Template-injected')
    );
    expect(row?.querySelector('.analysis-severity')?.textContent).toBe('INFO');
  });
});
