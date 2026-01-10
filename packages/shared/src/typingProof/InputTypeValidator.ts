/**
 * InputTypeValidator - 入力タイプ検証
 * 許可/禁止される入力タイプ、イベントタイプの判定を担当
 */

import type { InputType, EventType } from '../types.js';

// 有効なイベントタイプ（実行時検証用）
const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  'humanAttestation',
  'preExportAttestation',
  'termsAccepted',
  'contentChange',
  'contentSnapshot',
  'cursorPositionChange',
  'selectionChange',
  'externalInput',
  'editorInitialized',
  'mousePositionChange',
  'visibilityChange',
  'focusChange',
  'keyDown',
  'keyUp',
  'windowResize',
  'networkStatusChange',
  'codeExecution',
  'terminalInput',
  'screenshotCapture',
  'screenShareStart',
  'screenShareStop',
  'sessionResumed',
  'copyOperation',
]);

// 有効な入力タイプ（実行時検証用）
const VALID_INPUT_TYPES: ReadonlySet<string> = new Set([
  'insertText',
  'insertLineBreak',
  'insertParagraph',
  'insertTab',
  'insertFromComposition',
  'insertCompositionText',
  'deleteCompositionText',
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
  'insertFromPaste',
  'insertFromDrop',
  'insertFromYank',
  'insertReplacementText',
  'insertFromPasteAsQuotation',
  'insertFromInternalPaste',
  'replaceContent',
]);

// 許可される入力タイプ
const ALLOWED_INPUT_TYPES: readonly InputType[] = [
  'insertText',
  'insertLineBreak',
  'insertParagraph',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteSoftLineBackward',
  'deleteSoftLineForward',
  'deleteHardLineBackward',
  'deleteHardLineForward',
  'deleteByDrag',
  'historyUndo',
  'historyRedo',
  'insertCompositionText',
  'deleteCompositionText',
  'insertFromComposition',
  'insertFromInternalPaste'
] as const;

// 禁止される入力タイプ
const PROHIBITED_INPUT_TYPES: readonly InputType[] = [
  'insertFromPaste',
  'insertFromDrop',
  'insertFromYank',
  'insertReplacementText',
  'insertFromPasteAsQuotation'
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
  return typeof type === 'string' && VALID_EVENT_TYPES.has(type);
}

/**
 * 入力タイプが有効かチェック（実行時検証）
 */
export function validateInputType(type: unknown): type is InputType {
  return typeof type === 'string' && VALID_INPUT_TYPES.has(type);
}
