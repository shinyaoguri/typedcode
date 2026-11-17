// @vitest-environment happy-dom
/**
 * 外部入力 (paste / drop / copy) の検出範囲のテスト (#697)。
 *
 * コードの外部入力判定に渡すのは、コード編集領域 (Monaco に渡したコンテナ) が target のイベントだけ。
 * ターミナル (xterm の textarea) やエディタ外のフォームへの貼り付けから externalInput / contentChange を
 * 作ると、stdin を貼っただけでソースへの外部ペーストとして proof に載り、isPureTyping が false になる。
 * 実物の setupStaticEventListeners に Monaco の stub と記録の spy を渡して確かめる。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordEventInput } from '@typedcode/shared';

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));
vi.mock('../AppHelpers.js', () => ({ showNotification: () => {} }));
vi.mock('../../services/TurnstileService.js', () => ({ isTurnstileConfigured: () => false }));
vi.mock('../beforeUnloadGuard.js', () => ({ handleBeforeUnload: () => {} }));
vi.mock('../resetDialog.js', () => ({ confirmReset: () => {}, prepareResetDialog: () => {}, setupResetDialog: () => {} }));
const handleTemplateDrop = vi.fn();
vi.mock('../TemplateHandler.js', () => ({
  handleTemplateDrop: (...args: unknown[]) => handleTemplateDrop(...args),
  isTemplateFile: (file: File) => file.name.endsWith('.yaml'),
}));
vi.mock('../TerminalHandler.js', () => ({ showLanguageDescriptionInTerminal: () => {} }));

const { setupStaticEventListeners } = await import('../StaticEventListeners.js');
const { SessionContentRegistry } = await import('../../core/SessionContentRegistry.js');

const record = vi.fn<(event: RecordEventInput) => void>();
let contentRegistry: InstanceType<typeof SessionContentRegistry>;

beforeAll(() => {
  // index.html と同じ包含関係: エディタ領域 (.workbench) の中に Monaco のコンテナ (#editor。中に入力要素の
  // EditContext の div / textarea) とターミナルがある。フォームはエディタ領域の外
  document.body.innerHTML = `
    <main class="workbench">
      <div class="editor-container">
        <div id="editor"><div class="monaco-editor"><div class="view-lines"></div><div class="native-edit-context" tabindex="0"></div></div></div>
      </div>
      <div id="terminal-panel">
        <div id="xterm-container"><div class="xterm"><div class="xterm-rows"></div><textarea class="xterm-helper-textarea"></textarea></div></div>
      </div>
    </main>
    <form id="self-review"><input id="self-review-note" type="text"></form>`;
  contentRegistry = new SessionContentRegistry();
  const editorContainer = document.getElementById('editor')!;
  const ctx = {
    editor: {
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      getContainerDomNode: () => editorContainer,
    },
    contentRegistry,
    eventRecorder: { record },
    capabilities: {},
  };
  // 実物の配線を通す (ctx は使う部分だけの stub)
  setupStaticEventListeners(ctx as unknown as Parameters<typeof setupStaticEventListeners>[0]);
});

beforeEach(() => {
  record.mockClear();
  handleTemplateDrop.mockClear();
});

function el(selector: string): HTMLElement {
  return document.querySelector<HTMLElement>(selector)!;
}

function dataTransferWith(text: string): DataTransfer {
  const dt = new DataTransfer();
  // InputDetector は getData('text') で読む (ブラウザは text/plain に寄せるが happy-dom は寄せない)
  dt.setData('text', text);
  return dt;
}

function pasteInto(target: HTMLElement, text: string): void {
  target.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dataTransferWith(text), bubbles: true, cancelable: true })
  );
}

/** text (と任意のファイル) を持つ drop を発火する */
function dropInto(target: HTMLElement, text: string, file?: File): void {
  // happy-dom の DragEvent は素の Event で dataTransfer を持たないので、ブラウザと同じ形に足す
  const event = new DragEvent('drop', { bubbles: true, cancelable: true });
  const dataTransfer = { getData: (format: string) => (format === 'text' ? text : ''), files: file ? [file] : [] };
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
}

/** target の中の文字列を選択してから copy を発火する (InputDetector は window.getSelection で読む) */
function copyFrom(target: HTMLElement, text: string): void {
  target.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  target.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }));
  selection.removeAllRanges();
}

describe('setupStaticEventListeners: external input scope (#697)', () => {
  it.each([
    ['the terminal textarea', '.xterm-helper-textarea'],
    ['a form input outside the editor', '#self-review-note'],
  ])('records no code event when text is pasted into %s', (_label, selector) => {
    pasteInto(el(selector), '1 2\n');

    expect(record).not.toHaveBeenCalled();
  });

  it('records an external paste into the Monaco container as externalInput / insertFromPaste', () => {
    pasteInto(el('.native-edit-context'), 'PASTED_EXTERNAL_CODE');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      type: 'externalInput',
      inputType: 'insertFromPaste',
      data: 'PASTED_EXTERNAL_CODE',
    });
  });

  it('records a paste of content copied in the editor as contentChange / insertFromInternalPaste', () => {
    contentRegistry.registerCopiedContent('int internal = 1;');

    pasteInto(el('.native-edit-context'), 'int internal = 1;');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      type: 'contentChange',
      inputType: 'insertFromInternalPaste',
      data: 'int internal = 1;',
    });
  });

  it('records a drop on the editor area outside Monaco once as externalInput / insertFromDrop', () => {
    dropInto(el('.workbench'), 'DROPPED_ON_WORKBENCH');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({
      type: 'externalInput',
      inputType: 'insertFromDrop',
      data: 'DROPPED_ON_WORKBENCH',
    });
  });

  it('records a drop inside the Monaco container exactly once', () => {
    dropInto(el('.native-edit-context'), 'DROPPED_IN_MONACO');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ type: 'externalInput', inputType: 'insertFromDrop' });
  });

  it('records no code event for a drop outside the editor area', () => {
    dropInto(el('#self-review-note'), 'DROPPED_ON_FORM');

    expect(record).not.toHaveBeenCalled();
  });

  it('records a template file drop on the editor area once and hands the file to the template import', () => {
    const file = new File(['name: t'], 'template.yaml', { type: 'application/x-yaml' });

    dropInto(el('.workbench'), '', file);

    expect(handleTemplateDrop).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('does not treat text copied outside the editor as internal content for a later paste into the editor', () => {
    copyFrom(el('.xterm-rows'), 'TERMINAL_OUTPUT');
    expect(record).not.toHaveBeenCalled();

    pasteInto(el('.native-edit-context'), 'TERMINAL_OUTPUT');
    expect(record.mock.calls[0]![0]).toMatchObject({ type: 'externalInput', inputType: 'insertFromPaste' });
  });

  it('registers and records a copy made inside the Monaco container', () => {
    copyFrom(el('.view-lines'), 'COPIED_IN_EDITOR');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ type: 'copyOperation', data: 'COPIED_IN_EDITOR' });
    expect(contentRegistry.isInternalContent('COPIED_IN_EDITOR')).toBe(true);
  });
});
