// @vitest-environment happy-dom
/**
 * 分析カード (ADR-0009) の signal の表示。
 *
 * #416: templateInjection の文字数 signal は `summaryKey` で翻訳されて出る。key が ja / en のどちらかに
 * 無いと、`t()` がキー文字列を返して summary (英語の素の文) に落ちるので、ロケールごとに両方の数が
 * 読めることを実際の翻訳で固定する。
 */

import { runAnalysis, type AnalysisReport } from '@typedcode/shared';
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

describe('AnalysisReportCard: analyzers that could not finish (#301)', () => {
  const okSignal = {
    analyzerId: 'quiet',
    dimension: 'automation' as const,
    score: 1,
    confidence: 1,
    severity: 'notice' as const,
    evidence: [],
    summary: 'notice from the analyzer that finished',
  };

  function allFailed(): AnalysisReport {
    return {
      analyzerVersions: { boom: '1.0.0', hang: '1.0.0' },
      analyzerStatus: {
        boom: { version: '1.0.0', status: 'failed', message: '<img src=x onerror=alert(1)>' },
        hang: { version: '1.0.0', status: 'timeout', message: 'did not settle within 10000 ms' },
      },
      signals: [],
      reviewPriority: 0,
    };
  }

  function partlyFailed(signals: AnalysisReport['signals'] = []): AnalysisReport {
    return {
      analyzerVersions: { boom: '1.0.0', quiet: '1.0.0' },
      analyzerStatus: {
        boom: { version: '1.0.0', status: 'failed', message: 'analyzer failure' },
        quiet: { version: '1.0.0', status: 'ok' },
      },
      signals,
      reviewPriority: signals.length ? 0.5 : 0,
    };
  }

  const card = () => document.getElementById('card-analysis') as HTMLElement;
  const badge = () => document.getElementById('analysis-badge') as HTMLElement;

  it('marks the card unavailable when no analyzer finished', () => {
    new AnalysisReportCard().render(allFailed());
    expect(card().dataset['analysisAvailability']).toBe('unavailable');
  });

  it('labels the badge as analysis unavailable, as a warning, when every analyzer failed', () => {
    getI18n().setLocale('ja');
    new AnalysisReportCard().render(allFailed());
    expect(badge().textContent).toBe('分析不能');
    expect(badge().classList.contains('warning')).toBe(true);
  });

  it('does not say there are no signals when every analyzer failed', () => {
    getI18n().setLocale('en');
    new AnalysisReportCard().render(allFailed());
    expect(document.querySelector('#analysis-content .analysis-no-signals')).toBeNull();
    expect(badge().textContent).not.toBe('No analysis signals');
  });

  it('lists each analyzer with its status and escapes the untrusted message', () => {
    getI18n().setLocale('en');
    new AnalysisReportCard().render(allFailed());
    const statuses = [...document.querySelectorAll<HTMLElement>('#analysis-content .analysis-analyzer')].map(
      (el) => el.dataset['analyzerStatus']
    );
    expect(statuses).toEqual(['failed', 'timeout']);
    expect(document.querySelector('#analysis-content img')).toBeNull();
    expect(document.querySelector('#analysis-content .analysis-versions')?.textContent).toContain(
      'boom@1.0.0 (failed: <img src=x onerror=alert(1)>)'
    );
  });

  it('marks the card partial and keeps the signals of the analyzer that finished', () => {
    getI18n().setLocale('en');
    new AnalysisReportCard().render(partlyFailed([okSignal]));
    expect(card().dataset['analysisAvailability']).toBe('partial');
    expect(document.querySelector('#analysis-content .analysis-unavailable-note')).not.toBeNull();
    expect(renderedSummaries()).toEqual(['notice from the analyzer that finished']);
  });

  it('labels the badge partially unavailable instead of no signals when a partial run found nothing', () => {
    getI18n().setLocale('en');
    new AnalysisReportCard().render(partlyFailed());
    expect(badge().textContent).toBe('Partially unavailable');
    expect(document.querySelector('#analysis-content .analysis-no-signals')).toBeNull();
  });

  it('keeps the no-signals badge as success when every analyzer finished ok', () => {
    getI18n().setLocale('en');
    new AnalysisReportCard().render({
      analyzerVersions: { quiet: '1.0.0' },
      analyzerStatus: { quiet: { version: '1.0.0', status: 'ok' } },
      signals: [],
      reviewPriority: 0,
    });
    expect(card().dataset['analysisAvailability']).toBe('complete');
    expect(badge().textContent).toBe('No analysis signals');
    expect(badge().classList.contains('success')).toBe(true);
  });
});
