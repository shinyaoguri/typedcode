// @vitest-environment happy-dom
/**
 * 試験のスタートゲート (`ExamStartGate`) と授業の問題ローダ (`ClassProblemLoader`) の a11y (#743)。
 *
 * - 名前付きの modal dialog として開き、Tab / Shift+Tab が背景へ抜けない
 * - Escape では閉じない (閉鎖規則は #305 以前のまま: ゲートは解錠まで、ローダは「読み込む」「スキップ」だけ)
 * - ドロップゾーンはキーボードで届く button で、Enter / Space でファイル選択を開く
 * - 閉じると document の keydown リスナーが残らない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClassProblemLoader } from '../ClassProblemLoader.js';
import { ExamStartGate } from '../ExamStartGate.js';

function pressKey(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const byId = (id: string): HTMLElement => document.getElementById(id)!;

const surfaces = [
  {
    name: 'ExamStartGate',
    dialogName: 'exam-gate',
    open: (): void => void new ExamStartGate().prompt(),
    dropzone: 'exam-gate-dropzone',
    fileInput: 'exam-gate-file',
    // 監督コードの欄が初期フォーカス (従来の setTimeout での focus と同じ先)
    initialFocus: 'exam-gate-code',
  },
  {
    name: 'ClassProblemLoader',
    dialogName: 'class-problem-loader',
    open: (): void => void new ClassProblemLoader().prompt(),
    dropzone: 'class-loader-dropzone',
    fileInput: 'class-loader-file',
    initialFocus: 'class-loader-dropzone',
  },
] as const;

describe.each(surfaces)('$name accessibility', (surface) => {
  const overlay = (): HTMLElement => document.querySelector<HTMLElement>(`[data-dialog="${surface.dialogName}"]`)!;
  const dialog = (): HTMLElement => overlay().querySelector<HTMLElement>('[role="dialog"]')!;

  beforeEach(() => {
    document.body.innerHTML = '<button id="behind">behind</button>';
    byId('behind').focus();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens as a modal dialog named by its heading', () => {
    surface.open();
    expect(dialog()).not.toBeNull();
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog().getAttribute('aria-labelledby')!);
    expect(title?.tagName).toBe('H2');
    expect(title?.textContent?.trim()).not.toBe('');
  });

  it('moves the initial focus into the dialog', () => {
    surface.open();
    expect(document.activeElement).toBe(byId(surface.initialFocus));
  });

  it('wraps Tab and Shift+Tab inside the dialog instead of reaching the page behind', () => {
    surface.open();
    const focusable = [
      ...dialog().querySelectorAll<HTMLElement>('[tabindex="0"], input:not([hidden]), button:not([disabled])'),
    ];
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    expect(pressKey({ key: 'Tab' }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(pressKey({ key: 'Tab', shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('stays open on Escape', () => {
    surface.open();
    pressKey({ key: 'Escape' });
    expect(overlay().classList.contains('hidden')).toBe(false);
    expect(overlay().isConnected).toBe(true);
  });

  it('exposes the drop zone as a keyboard-reachable button named by the field label', () => {
    surface.open();
    const zone = byId(surface.dropzone);
    expect(zone.getAttribute('role')).toBe('button');
    expect(zone.tabIndex).toBe(0);
    const names = zone
      .getAttribute('aria-labelledby')!
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim());
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n)).toBe(true);
  });

  it.each(['Enter', ' '])('opens the file picker when %j is pressed on the drop zone', (key) => {
    surface.open();
    const input = byId(surface.fileInput) as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    const zone = byId(surface.dropzone);
    zone.focus();
    const event = pressKey({ key }, zone);
    expect(click).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('ClassProblemLoader closing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('returns focus to the button that opened it and releases its keydown listener when skipped', async () => {
    document.body.innerHTML = '<button id="load-problem-btn">load</button>';
    const opener = byId('load-problem-btn');
    opener.focus();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const result = new ClassProblemLoader().prompt();
    byId('class-loader-skip').click();
    await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(opener);
    const count = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add)).toBe(1);
    expect(count(remove)).toBe(1);
  });
});
