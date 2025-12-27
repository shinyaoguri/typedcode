/**
 * Monaco Editor 拡張型定義
 */

import type * as monaco from 'monaco-editor';

/** Monaco Editor インスタンス */
export type MonacoEditor = monaco.editor.IStandaloneCodeEditor;

/** Monaco Editor モデル変更イベント */
export type ModelContentChange = monaco.editor.IModelContentChange;

/** Monaco Editor コンテンツ変更イベント */
export type ModelContentChangedEvent = monaco.editor.IModelContentChangedEvent;

/** Monaco Editor カーソル位置変更イベント */
export type CursorPositionChangedEvent = monaco.editor.ICursorPositionChangedEvent;

/** Monaco Editor 選択変更イベント */
export type CursorSelectionChangedEvent = monaco.editor.ICursorSelectionChangedEvent;
