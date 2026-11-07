// @vitest-environment happy-dom
/**
 * 問題パネルの入出力例 (#648 / ADR-0048) のテスト。
 * E2E (`packages/e2e/tests/scenarios/problem-examples.spec.ts`) が読む状態契約 (data-*) と、
 * コピーが stdin を元の文字列のまま渡すことを固定する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProblemExample } from '@typedcode/shared';

import { ProblemPanel } from '../ProblemPanel.js';

const examples: ProblemExample[] = [
  { name: '例1', stdin: '3 5\n', stdout: '8\n' },
  { name: '入力なし', stdin: '', stdout: 'hello\nworld\n' },
];

function mountPanel(): ProblemPanel {
  document.body.innerHTML = `
    <div id="problem-panel" data-open="false">
      <div class="problem-content"><div id="problem-body" class="problem-body"></div></div>
    </div>`;
  const panel = new ProblemPanel();
  panel.initialize();
  return panel;
}

function section(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#problem-examples');
}

function blocks(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#problem-examples .problem-example')];
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ProblemPanel.setProblem examples', () => {
  it('renders one block per example with the count, index, name, input and output from the package', () => {
    mountPanel().setProblem('# 問題', examples);
    expect(section()!.dataset.exampleCount).toBe('2');
    const rendered = blocks().map((block) => ({
      index: block.dataset.exampleIndex,
      name: block.querySelector('[data-role="name"]')!.textContent,
      stdin: block.querySelector('pre[data-role="stdin"]')?.textContent ?? null,
      noInput: block.querySelector('[data-role="no-input"]') !== null,
      stdout: block.querySelector('pre[data-role="stdout"]')!.textContent,
    }));
    // <pre> は末尾の改行 1 つを除いて見せる
    expect(rendered).toEqual([
      { index: '0', name: '例1', stdin: '3 5', noInput: false, stdout: '8' },
      { index: '1', name: '入力なし', stdin: null, noInput: true, stdout: 'hello\nworld' },
    ]);
  });

  it('puts the examples section after the statement, not inside the rendered markdown', () => {
    mountPanel().setProblem('# 問題', examples);
    const body = document.getElementById('problem-body')!;
    expect(body.querySelector('#problem-examples')).toBeNull();
    expect(body.nextElementSibling).toBe(section());
  });

  it('does not render the examples section for a problem without examples', () => {
    mountPanel().setProblem('# 問題');
    expect(section()).toBeNull();
  });

  it('does not render the examples section for an empty examples array', () => {
    mountPanel().setProblem('# 問題', []);
    expect(section()).toBeNull();
  });

  it('removes the previous problem examples when switching to a problem without examples', () => {
    const panel = mountPanel();
    panel.setProblem('# 問題1', examples);
    panel.setProblem('# 問題2');
    expect(section()).toBeNull();
  });

  it('replaces the previous problem examples instead of stacking a second section', () => {
    const panel = mountPanel();
    panel.setProblem('# 問題1', examples);
    panel.setProblem('# 問題2', [{ name: 'only', stdin: '1\n', stdout: '1\n' }]);
    expect(document.querySelectorAll('#problem-examples')).toHaveLength(1);
    expect(section()!.dataset.exampleCount).toBe('1');
  });

  it('shows example text as text, never as HTML', () => {
    mountPanel().setProblem('# 問題', [
      { name: '<img src=x onerror=alert(1)>', stdin: '<b>1</b>\n', stdout: '<i>2</i>' },
    ]);
    expect(section()!.querySelector('img, b, i:not(.fas)')).toBeNull();
    expect(section()!.querySelector('pre[data-role="stdin"]')!.textContent).toBe('<b>1</b>');
  });

  it('offers a copy button only for examples that have an input', () => {
    mountPanel().setProblem('# 問題', examples);
    const copyButtons = blocks().map((block) => block.querySelectorAll('[data-action="copy-stdin"]').length);
    expect(copyButtons).toEqual([1, 0]);
  });
});

describe('ProblemPanel copy-stdin', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  });

  it('copies the example stdin exactly as distributed, including its trailing newline', async () => {
    mountPanel().setProblem('# 問題', [{ name: 'crlf', stdin: '3\r\n5\n', stdout: '8\n' }]);
    document.querySelector<HTMLButtonElement>('[data-action="copy-stdin"]')!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('3\r\n5\n');
  });

  it('marks the copy button as copied for two seconds after a successful copy', async () => {
    vi.useFakeTimers();
    mountPanel().setProblem('# 問題', examples);
    const button = document.querySelector<HTMLButtonElement>('[data-action="copy-stdin"]')!;
    button.click();
    await vi.advanceTimersByTimeAsync(0); // writeText の解決を流す
    expect(button.classList.contains('copied')).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(button.classList.contains('copied')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(button.classList.contains('copied')).toBe(false);
  });
});
