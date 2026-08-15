/**
 * InputTypeValidator の実行時許可セットが型 union と同期していることのテスト (#222)。
 *
 * かつて `VALID_EVENT_TYPES` は手書きの Set で、`EventType` union に追加された
 * `environmentProbe` / `fullscreenChange` / `examOpened` が漏れていた。実装側は
 * `Record<EventType, true>` から導出して tsc に漏れを検出させているが、ここでは
 * 「union の全メンバを受理し、union 外を持たない」ことを実行時にも固定する。
 *
 * 下のリテラル一覧も `Record<EventType, true>` / `Record<InputType, true>` なので、
 * union に型を足すとこのテスト自身も tsc に指摘される (仕様の二重記述ではなく確認)。
 */

import { describe, expect, it } from 'vitest';
import {
  VALID_EVENT_TYPES,
  VALID_INPUT_TYPES,
  validateEventType,
  validateInputType,
} from '../typingProof/InputTypeValidator.js';
import type { EventType, InputType } from '../types.js';

const ALL_EVENT_TYPES: Record<EventType, true> = {
  humanAttestation: true,
  preExportAttestation: true,
  termsAccepted: true,
  contentChange: true,
  contentSnapshot: true,
  cursorPositionChange: true,
  selectionChange: true,
  externalInput: true,
  editorInitialized: true,
  mousePositionChange: true,
  visibilityChange: true,
  focusChange: true,
  keyDown: true,
  keyUp: true,
  windowResize: true,
  networkStatusChange: true,
  codeExecution: true,
  terminalInput: true,
  screenshotCapture: true,
  screenShareStart: true,
  screenShareStop: true,
  templateInjection: true,
  sessionResumed: true,
  copyOperation: true,
  screenShareOptOut: true,
  reflectionNote: true,
  environmentProbe: true,
  fullscreenChange: true,
  examOpened: true,
};

const ALL_INPUT_TYPES: Record<InputType, true> = {
  insertText: true,
  insertLineBreak: true,
  insertParagraph: true,
  insertTab: true,
  insertFromComposition: true,
  insertCompositionText: true,
  deleteCompositionText: true,
  deleteContentBackward: true,
  deleteContentForward: true,
  deleteWordBackward: true,
  deleteWordForward: true,
  deleteSoftLineBackward: true,
  deleteSoftLineForward: true,
  deleteHardLineBackward: true,
  deleteHardLineForward: true,
  deleteByDrag: true,
  deleteByCut: true,
  historyUndo: true,
  historyRedo: true,
  insertFromPaste: true,
  insertFromDrop: true,
  insertFromYank: true,
  insertReplacementText: true,
  insertFromPasteAsQuotation: true,
  insertFromInternalPaste: true,
  replaceContent: true,
};

describe('InputTypeValidator stays in sync with the type unions (#222)', () => {
  it('accepts every member of the EventType union', () => {
    for (const eventType of Object.keys(ALL_EVENT_TYPES)) {
      expect(validateEventType(eventType), eventType).toBe(true);
    }
  });

  it('has no valid event type outside the EventType union', () => {
    expect([...VALID_EVENT_TYPES].sort()).toEqual(Object.keys(ALL_EVENT_TYPES).sort());
    expect(validateEventType('notAnEventType')).toBe(false);
  });

  it('accepts every member of the InputType union', () => {
    for (const inputType of Object.keys(ALL_INPUT_TYPES)) {
      expect(validateInputType(inputType), inputType).toBe(true);
    }
  });

  it('has no valid input type outside the InputType union', () => {
    expect([...VALID_INPUT_TYPES].sort()).toEqual(Object.keys(ALL_INPUT_TYPES).sort());
    expect(validateInputType('notAnInputType')).toBe(false);
  });
});
