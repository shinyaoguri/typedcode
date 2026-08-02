/**
 * Monaco Editor Worker Configuration
 * Monacoエディタのワーカー設定を一元管理
 */

import type * as monaco from 'monaco-editor';
// monaco-editor 0.56 の exports マップ準拠 (esm/vs/ プレフィックスは exports 側が付与)
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

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
    },
  };
}
