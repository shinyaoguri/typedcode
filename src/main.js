import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import './style.css';

// Monaco Editor の Worker 設定
self.MonacoEnvironment = {
  getWorker(_, label) {
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

// エディタの初期化
const editor = monaco.editor.create(document.getElementById('editor'), {
  value: '// TypedCode へようこそ！\n// シンプルで拡張しやすいコードエディタです\n\nfunction hello() {\n  console.log("Hello, World!");\n}\n\nhello();',
  language: 'javascript',
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: {
    enabled: true
  },
  fontSize: 14,
  lineNumbers: 'on',
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  wrappingIndent: 'indent'
});

// 言語切り替え
const languageSelector = document.getElementById('language-selector');
languageSelector.addEventListener('change', (e) => {
  const model = editor.getModel();
  monaco.editor.setModelLanguage(model, e.target.value);
});

// ダウンロード機能
const downloadBtn = document.getElementById('download-btn');
downloadBtn.addEventListener('click', () => {
  const content = editor.getValue();
  const language = languageSelector.value;
  const extension = getFileExtension(language);
  const filename = `code.${extension}`;

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

// ファイル拡張子の取得
function getFileExtension(language) {
  const extensions = {
    javascript: 'js',
    typescript: 'ts',
    c: 'c',
    cpp: 'cpp',
    html: 'html',
    css: 'css',
    json: 'json',
    markdown: 'md',
    python: 'py'
  };
  return extensions[language] || 'txt';
}

// LocalStorage にコンテンツを保存
editor.onDidChangeModelContent(() => {
  localStorage.setItem('editorContent', editor.getValue());
  localStorage.setItem('editorLanguage', languageSelector.value);
});

// LocalStorage からコンテンツを復元
window.addEventListener('DOMContentLoaded', () => {
  const savedContent = localStorage.getItem('editorContent');
  const savedLanguage = localStorage.getItem('editorLanguage');

  if (savedContent) {
    editor.setValue(savedContent);
  }

  if (savedLanguage) {
    languageSelector.value = savedLanguage;
    const model = editor.getModel();
    monaco.editor.setModelLanguage(model, savedLanguage);
  }
});

// エディタインスタンスをエクスポート（拡張用）
export { editor, monaco };
