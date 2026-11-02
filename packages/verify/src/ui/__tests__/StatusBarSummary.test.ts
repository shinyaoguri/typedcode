// @vitest-environment happy-dom
/**
 * ステータスバーの検証サマリ (#282)。集約の数値は `#queue-status` の data-proof-* にも出る
 * (状態契約。verify/AGENTS.md)。判定が無いとき (検証中・Ready・エラー表示) は属性を外す。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBarUI } from '../StatusBarUI.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

function queueStatus(): HTMLElement {
  return document.getElementById('queue-status')!;
}

function proofAttrs() {
  const { proofTotal, proofPassed, proofFailed } = queueStatus().dataset;
  return { total: proofTotal, passed: proofPassed, failed: proofFailed };
}

beforeEach(() => {
  mountVerifyIndexHtml();
});

describe('StatusBarUI.setSummary', () => {
  it('shows passed/total, the failed count and the data-proof-* attributes', () => {
    const bar = new StatusBarUI();

    bar.setSummary({ passed: 2, total: 3, failed: 1 });

    expect(proofAttrs()).toEqual({ total: '3', passed: '2', failed: '1' });
    expect(queueStatus().textContent).toContain('2/3');
    expect(queueStatus().querySelector('.status-summary-failed')).not.toBeNull();
    expect(queueStatus().classList.contains('has-failure')).toBe(true);
  });

  it('reports 1/1 without a failure marker for a single passing proof', () => {
    const bar = new StatusBarUI();

    bar.setSummary({ passed: 1, total: 1, failed: 0 });

    expect(proofAttrs()).toEqual({ total: '1', passed: '1', failed: '0' });
    expect(queueStatus().querySelector('.status-summary-failed')).toBeNull();
    expect(queueStatus().classList.contains('has-failure')).toBe(false);
  });

  it.each([
    ['setReady', (bar: StatusBarUI) => bar.setReady()],
    ['setVerifying', (bar: StatusBarUI) => bar.setVerifying(1, 3)],
    ['setError', (bar: StatusBarUI) => bar.setError('boom')],
    ['setMessage', (bar: StatusBarUI) => bar.setMessage('hello')],
  ])('drops the data-proof-* attributes and the failure look once %s replaces the summary', (_name, replace) => {
    const bar = new StatusBarUI();
    bar.setSummary({ passed: 0, total: 1, failed: 1 });

    replace(bar);

    expect(proofAttrs()).toEqual({ total: undefined, passed: undefined, failed: undefined });
    expect(queueStatus().classList.contains('has-failure')).toBe(false);
    expect(queueStatus().classList.contains('clickable')).toBe(false);
  });
});

describe('StatusBarUI failed-summary click', () => {
  it('invokes the handler only while the summary contains a failure', () => {
    const bar = new StatusBarUI();
    const onClick = vi.fn();
    bar.setOnFailedClick(onClick);

    bar.setSummary({ passed: 1, total: 1, failed: 0 });
    queueStatus().click();
    expect(onClick).not.toHaveBeenCalled();

    bar.setSummary({ passed: 1, total: 2, failed: 1 });
    queueStatus().click();
    expect(onClick).toHaveBeenCalledTimes(1);

    bar.setReady();
    queueStatus().click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
