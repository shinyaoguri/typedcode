// @vitest-environment happy-dom
/**
 * パネル・ダイアログ・入口の画面の状態契約 (data-*) のテスト (#434 / #644)。
 * E2E (`packages/e2e/tests/scenarios/`) はこの属性だけを読んで開閉・選択を判定するので、
 * `.visible` / `.hidden` などの class や表示テキストとは独立に、値そのものを固定する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClassProblemLoader } from '../ClassProblemLoader.js';
import { renderModeBadge } from '../ModeBadge.js';
import { NotFoundPage } from '../NotFoundPage.js';
import { showTermsNotice } from '../TermsNotice.js';
import { LogViewer } from '../LogViewer.js';
import { ProblemPanel } from '../ProblemPanel.js';
import { SelfReviewDialog } from '../SelfReviewDialog.js';
import type { ProcessSummary, TypingProof } from '@typedcode/shared';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('#log-viewer data-open', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="editor-container"></div><div id="log-viewer" data-open="false"><div id="log-entries"></div></div>';
  });

  function viewer(): LogViewer {
    const proof = { events: [] } as unknown as TypingProof;
    return new LogViewer(document.getElementById('log-entries')!, proof);
  }

  it('reports data-open="true" while the log viewer is shown and "false" after it is hidden again', () => {
    const v = viewer();
    const el = document.getElementById('log-viewer')!;
    v.show();
    expect(el.dataset.open).toBe('true');
    v.hide();
    expect(el.dataset.open).toBe('false');
    v.toggle();
    expect(el.dataset.open).toBe('true');
  });
});

describe('#problem-panel data-open', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div><div id="problem-panel"><div id="problem-resize-handle"></div><button id="close-problem-btn"></button>
      <div id="problem-body"></div></div></div>
      <div class="editor-container"></div><button id="toggle-problem-btn"></button>`;
  });

  it('reports data-open="false" right after initialize and follows show, the close button and the toggle', () => {
    const panel = new ProblemPanel();
    expect(panel.initialize()).toBe(true);
    const el = document.getElementById('problem-panel')!;
    expect(el.dataset.open).toBe('false');
    panel.show();
    expect(el.dataset.open).toBe('true');
    document.getElementById('close-problem-btn')!.click();
    expect(el.dataset.open).toBe('false');
    document.getElementById('toggle-problem-btn')!.click();
    expect(el.dataset.open).toBe('true');
  });
});

describe('class problem loader data-dialog', () => {
  it('names its overlay "class-problem-loader" and marks it hidden once skipped', async () => {
    const result = new ClassProblemLoader().prompt();
    const overlay = document.querySelector<HTMLElement>('[data-dialog="class-problem-loader"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.classList.contains('hidden')).toBe(false);
    document.getElementById('class-loader-skip')!.click();
    await expect(result).resolves.toBeNull();
    expect(overlay!.classList.contains('hidden')).toBe(true);
  });
});

describe('self-review data-action', () => {
  const summary = {
    durationMs: 1000,
    insertedChars: 1,
    deletedChars: 0,
    hasRunResults: false,
    executionCount: 0,
    runSuccessCount: 0,
    runFailureCount: 0,
    pauseCount: 0,
  } as unknown as ProcessSummary;

  it('resolves proceed with the trimmed note when the data-action="proceed" button is pressed', async () => {
    const result = new SelfReviewDialog().show(summary);
    document.querySelector<HTMLTextAreaElement>('#self-review-note')!.value = '  note  ';
    document.querySelector<HTMLElement>('[data-dialog="self-review"] [data-action="proceed"]')!.click();
    await expect(result).resolves.toEqual({ proceed: true, note: 'note' });
    expect(document.querySelector('[data-dialog="self-review"]')).toBeNull();
  });

  it('marks both the cancel button and the close (x) button as data-action="cancel", and either cancels', async () => {
    for (const index of [0, 1]) {
      const result = new SelfReviewDialog().show(summary);
      const cancels = document.querySelectorAll<HTMLElement>('[data-dialog="self-review"] [data-action="cancel"]');
      expect(cancels).toHaveLength(2);
      cancels[index]!.click();
      await expect(result).resolves.toEqual({ proceed: false, note: '' });
    }
  });
});

describe('not-found page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="init-overlay"></div><div id="app"></div>';
  });

  it('hides the editor shell and the boot overlay and offers only a link back to /', () => {
    new NotFoundPage().render();
    expect(document.getElementById('app')!.style.display).toBe('none');
    expect(document.getElementById('init-overlay')!.classList.contains('hidden')).toBe(true);
    const links = document.querySelectorAll<HTMLAnchorElement>('#not-found-page a');
    expect([...links].map((a) => a.getAttribute('href'))).toEqual(['/']);
    expect(links[0]!.dataset.action).toBe('open-editor');
  });
});

describe('mode badge', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="titlebar-left"></div>';
  });

  it('shows the current mode as data-mode in the titlebar without any button or menu', () => {
    const badge = renderModeBadge('exam');
    expect(badge.parentElement?.className).toBe('titlebar-left');
    expect(badge.dataset.mode).toBe('exam');
    expect(badge.querySelectorAll('button, a, [role="menu"], [role="menuitem"]')).toHaveLength(0);
    expect(badge.tagName).not.toBe('BUTTON');
  });
});

describe('terms notice', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"><div class="titlebar"></div></div>';
  });

  function notice(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-banner="terms"]');
  }

  it('is inserted at the top of #app and calls onAccepted exactly once when OK is pressed, then leaves the DOM', () => {
    const onAccepted = vi.fn();
    showTermsNotice({ openTerms: () => new Promise(() => {}), onAccepted });
    expect(document.getElementById('app')!.firstElementChild).toBe(notice());

    const ok = notice()!.querySelector<HTMLButtonElement>('[data-action="ok"]')!;
    ok.click();
    ok.click();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(notice()).toBeNull();
  });

  it('opens the terms through openTerms and accepts once the terms are agreed to there', async () => {
    let agree: () => void = () => {};
    const openTerms = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          agree = resolve;
        })
    );
    const onAccepted = vi.fn();
    showTermsNotice({ openTerms, onAccepted });

    notice()!.querySelector<HTMLButtonElement>('[data-action="open-terms"]')!.click();
    expect(openTerms).toHaveBeenCalledTimes(1);
    // 規約を開いている間は OK を押せない (二重に進まない)
    expect(notice()!.querySelector<HTMLButtonElement>('[data-action="ok"]')!.disabled).toBe(true);
    expect(onAccepted).not.toHaveBeenCalled();

    agree();
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(notice()).toBeNull();
  });

  it('carries the scope note (#240) after the notice text', () => {
    showTermsNotice({ openTerms: () => Promise.resolve(), onAccepted: vi.fn() });
    const note = notice()!.querySelector<HTMLElement>('[data-note="scope"]');
    expect(note).not.toBeNull();
    expect(note!.textContent!.trim()).not.toBe('');
  });

  it('does not stack a second notice when shown twice', () => {
    showTermsNotice({ openTerms: () => Promise.resolve(), onAccepted: vi.fn() });
    showTermsNotice({ openTerms: () => Promise.resolve(), onAccepted: vi.fn() });
    expect(document.querySelectorAll('[data-banner="terms"]')).toHaveLength(1);
  });
});
