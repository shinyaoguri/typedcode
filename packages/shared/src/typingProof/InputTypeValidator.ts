/**
 * InputTypeValidator - 入力タイプ検証
 * 許可/禁止される入力タイプ、イベントタイプの判定を担当
 */

import type { InputType, EventType } from '../types.js';

/**
 * 有効なイベントタイプ（実行時検証用）。
 *
 * **手書きの Set にしないこと** (#222)。`Record<EventType, true>` から導出しているので、
 * `EventType` union に型を足すとこの表の記入漏れを tsc が検出する。かつて手書きの Set が
 * union から取り残され、`environmentProbe` / `fullscreenChange` / `examOpened` の 3 種が
 * 実行時検証で「無効」になっていた (同期の崩れは CLAUDE.md の「よくある罠」でも既知)。
 */
const EVENT_TYPE_MEMBERS: Record<EventType, true> = {
  humanAttestation: true,
  preExportAttestation: true,
  termsAccepted: true,
  contentChange: true,
  contentSnapshot: true,
  cursorPositionChange: true,
  selectionChange: true,
  externalInput: true,
  editorInitialized: true,
  reflectionNote: true,
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
  environmentProbe: true,
  fullscreenChange: true,
  examOpened: true,
};

export const VALID_EVENT_TYPES: ReadonlySet<EventType> = new Set(Object.keys(EVENT_TYPE_MEMBERS) as EventType[]);

/** 有効な入力タイプ（実行時検証用）。`EVENT_TYPE_MEMBERS` と同じく union から導出する (#222)。 */
const INPUT_TYPE_MEMBERS: Record<InputType, true> = {
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

export const VALID_INPUT_TYPES: ReadonlySet<InputType> = new Set(Object.keys(INPUT_TYPE_MEMBERS) as InputType[]);

// 許可される入力タイプ
const ALLOWED_INPUT_TYPES: readonly InputType[] = [
  'insertText',
  'insertLineBreak',
  'insertParagraph',
  'insertTab',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteHardLineBackward',
  'deleteHardLineForward',
  'deleteByDrag',
  'deleteByCut',
  'historyUndo',
  'historyRedo',
  'insertCompositionText',
  'deleteCompositionText',
  'insertFromComposition',
  'insertFromInternalPaste',
] as const;

// 禁止される入力タイプ
const PROHIBITED_INPUT_TYPES: readonly InputType[] = [
  'insertFromPaste',
  'insertFromDrop',
  'insertFromYank',
  'insertReplacementText',
  'insertFromPasteAsQuotation',
] as const;

/**
 * 入力タイプが許可されているかチェック
 */
export function isAllowedInputType(inputType: InputType): boolean {
  return ALLOWED_INPUT_TYPES.includes(inputType);
}

/**
 * 禁止される操作かチェック
 */
export function isProhibitedInputType(inputType: InputType): boolean {
  return PROHIBITED_INPUT_TYPES.includes(inputType);
}

/**
 * 許可される入力タイプの一覧を取得
 */
export function getAllowedInputTypes(): readonly InputType[] {
  return ALLOWED_INPUT_TYPES;
}

/**
 * 禁止される入力タイプの一覧を取得
 */
export function getProhibitedInputTypes(): readonly InputType[] {
  return PROHIBITED_INPUT_TYPES;
}

/**
 * イベントタイプが有効かチェック（実行時検証）
 */
export function validateEventType(type: unknown): type is EventType {
  return typeof type === 'string' && VALID_EVENT_TYPES.has(type as EventType);
}

/**
 * 入力タイプが有効かチェック（実行時検証）
 */
export function validateInputType(type: unknown): type is InputType {
  return typeof type === 'string' && VALID_INPUT_TYPES.has(type as InputType);
}
