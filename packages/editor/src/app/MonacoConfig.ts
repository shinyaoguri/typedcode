/**
 * Monaco Editor Worker Configuration
 * Monacoエディタのワーカー設定を一元管理
 */

import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare const self: Window & typeof globalThis & { MonacoEnvironment: monaco.Environment };

/**
 * Monaco Editorのワーカー環境を設定
 * アプリケーション起動時に1回呼び出す
 */
export function configureMonacoWorkers(): void {
  self.MonacoEnvironment = {
    getWorker(_: string, label: string): Worker {
      if (label === 'json') {
        return new jsonWorker();
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new cssWorker();
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    }
  };
}
