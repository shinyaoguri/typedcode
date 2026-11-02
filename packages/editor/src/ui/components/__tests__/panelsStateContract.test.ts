// @vitest-environment happy-dom
/**
 * パネル・ダイアログ・ランディングの状態契約 (data-*) のテスト (#434)。
 * E2E (`packages/e2e/tests/scenarios/`) はこの属性だけを読んで開閉・選択・進行中セッションを判定するので、
 * `.visible` / `.hidden` などの class や表示テキストとは独立に、値そのものを固定する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModeSessionInfo } from '../../../core/SessionDetector.js';
import type { EditorMode } from '../../../core/mode.js';

type Sessions = Record<EditorMode, ModeSessionInfo | null>;

/** ランディングのセッション検出を、テストが解決するタイミングまで止めておく代役。 */
const detection = vi.hoisted(() => {
  let resolve: (value: unknown) => void = () => {};
  return {
    reset(): void {
      this.promise = new Promise((r) => {
        resolve = r;
      });
    },
    promise: Promise.resolve() as Promise<unknown>,
    finish(value: unknown): void {
      resolve(value);
    },
  };
});

vi.mock('../../../core/SessionDetector.js', () => ({
  detectModeSessions: () => detection.promise,
}));

import { ClassProblemLoader } from '../ClassProblemLoader.js';
import { LandingPage } from '../LandingPage.js';
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

describe('landing session badge data-tab-count', () => {
  beforeEach(() => {
    detection.reset();
  });

  function badge(mode: EditorMode): HTMLElement {
    return document.querySelector<HTMLElement>(`.landing-card-mode[data-mode="${mode}"] .session-badge`)!;
  }

  it('has no data-tab-count until detection finishes, then shows N on cards with a session and 0 elsewhere', async () => {
    new LandingPage().render();
    expect(badge('casual').hasAttribute('data-tab-count')).toBe(false);

    const sessions: Sessions = {
      casual: { hasSession: true, tabCount: 2, lastModifiedAt: null },
      class: null,
      assignment: null,
      exam: null,
    };
    detection.finish(sessions);
    await vi.waitFor(() => expect(badge('casual').dataset.tabCount).toBe('2'));
    expect(badge('casual').hidden).toBe(false);
    for (const mode of ['class', 'assignment', 'exam'] as const) {
      expect(badge(mode).dataset.tabCount).toBe('0');
      expect(badge(mode).hidden).toBe(true);
    }
  });
});
