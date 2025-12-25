import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import './style.css';
import { TypingProof } from './typingProof.js';
import { InputDetector } from './inputDetector.js';
import { OperationDetector } from './operationDetector.js';
import { LogViewer } from './logViewer.js';
import { ThemeManager } from './themeManager.js';
import { Fingerprint } from './fingerprint.js';

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

// タイピング証明システムの初期化
const typingProof = new TypingProof();

// 操作検出器の初期化
const operationDetector = new OperationDetector();

// ログビューアの初期化（DOMContentLoaded後に行う）
let logViewer = null;

// 前回のカーソル位置を記録（重複イベント防止用）
let lastCursorPosition = null;
let lastCursorTime = 0;
let lastSelectionRange = null;
let lastSelectionTime = 0;

// イベント記録を無効化するフラグ（リセット時などに使用）
let isEventRecordingEnabled = true;

// UI要素の取得
const eventCountEl = document.getElementById('event-count');
const currentHashEl = document.getElementById('current-hash');
const blockNotificationEl = document.getElementById('block-notification');
const blockMessageEl = document.getElementById('block-message');

// 通知を表示
function showNotification(message) {
  blockMessageEl.textContent = message;
  blockNotificationEl.classList.remove('hidden');

  setTimeout(() => {
    blockNotificationEl.classList.add('hidden');
  }, 2000);
}

// エディタの初期化
const editor = monaco.editor.create(document.getElementById('editor'), {
  value: '// TypedCode へようこそ！\n// タイピング証明エディタです\n// コピー&ペーストを検出・記録します\n\n#include<stdio.h>\n int main() {\n  printf("Hello, World!");\n  return 0;\n}\n',
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

// テーマ管理の初期化
const themeManager = new ThemeManager(editor);

// 言語切り替え
const languageSelector = document.getElementById('language-selector');
languageSelector.addEventListener('change', (e) => {
  const model = editor.getModel();
  monaco.editor.setModelLanguage(model, e.target.value);
});

// 入力検出器の初期化
const inputDetector = new InputDetector(document.body, async (detectedEvent) => {
  showNotification(detectedEvent.message);
  console.log('[TypedCode] Detected operation:', detectedEvent);

  // コピペやドロップをログに記録
  if (detectedEvent.type === 'paste' || detectedEvent.type === 'drop') {
    // カーソル位置を取得
    const position = editor.getPosition();

    const event = {
      type: 'externalInput',
      inputType: detectedEvent.type === 'paste' ? 'insertFromPaste' : 'insertFromDrop',
      data: detectedEvent.data.text,
      rangeLength: detectedEvent.data.length,
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      },
      description: detectedEvent.type === 'paste' ?
        `ペースト（${detectedEvent.data.length}文字）` :
        `ドロップ（${detectedEvent.data.length}文字）`
    };

    const result = await typingProof.recordEvent(event);

    // ログビューアに追加
    if (logViewer && logViewer.isVisible) {
      const recordedEvent = typingProof.events[result.index];
      logViewer.addLogEntry(recordedEvent, result.index);
    }

    updateProofStatus();
  }
});

// リセット機能
const resetBtn = document.getElementById('reset-btn');
resetBtn.addEventListener('click', async () => {
  if (confirm('エディタの内容と操作ログを全て削除してリセットしますか？\nこの操作は取り消せません。')) {
    // イベント記録を一時的に無効化
    isEventRecordingEnabled = false;

    // TypingProofをリセット（非同期）
    await typingProof.reset();

    // ログビューアをクリア
    if (logViewer) {
      logViewer.clear();
    }

    // LocalStorageをクリア
    localStorage.removeItem('editorContent');

    // UIを更新
    updateProofStatus();

    // エディタをクリア
    editor.setValue('');

    // イベント記録を再度有効化
    isEventRecordingEnabled = true;

    showNotification('リセットしました');
  }
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

// エディタの変更イベントを監視してタイピング証明を記録
editor.onDidChangeModelContent(async (e) => {
  // イベント記録が無効化されている場合はスキップ
  if (!isEventRecordingEnabled) {
    return;
  }

  // 変更内容を記録（詳細な操作種別を推定）
  for (const change of e.changes) {
    // 操作種別を検出
    const operation = operationDetector.detectOperationType(change, e);
    const description = operationDetector.getOperationDescription(operation);

    const event = {
      type: 'contentChange',
      inputType: operation.inputType,
      data: operation.text,
      rangeOffset: operation.rangeOffset,
      rangeLength: operation.rangeLength,
      range: operation.range,
      isMultiLine: operation.isMultiLine,
      description: description,
      // 追加の詳細情報
      ...(operation.deletedLength && { deletedLength: operation.deletedLength }),
      ...(operation.insertedText && { insertedText: operation.insertedText }),
      ...(operation.insertLength && { insertLength: operation.insertLength }),
      ...(operation.deleteDirection && { deleteDirection: operation.deleteDirection })
    };

    const result = await typingProof.recordEvent(event);

    // ログビューアに追加（表示されている場合）
    if (logViewer && logViewer.isVisible) {
      const recordedEvent = typingProof.events[result.index];
      logViewer.addLogEntry(recordedEvent, result.index);
    }

    // デバッグログ（開発時のみ）
    if (process.env.NODE_ENV === 'development') {
      console.log('[TypedCode] Operation detected:', {
        type: operation.inputType,
        description,
        text: operation.text.substring(0, 20) + (operation.text.length > 20 ? '...' : '')
      });
    }
  }

  // UI を更新
  updateProofStatus();

  // LocalStorage にコンテンツを保存
  localStorage.setItem('editorContent', editor.getValue());
  localStorage.setItem('editorLanguage', languageSelector.value);
});

// カーソル位置変更イベントを記録
editor.onDidChangeCursorPosition(async (e) => {
  // イベント記録が無効化されている場合はスキップ
  if (!isEventRecordingEnabled) {
    return;
  }

  // 前回と同じ位置への移動は無視（重複イベント防止）
  // 50ms以内の同一位置への移動は重複とみなす
  const currentPos = `${e.position.lineNumber}:${e.position.column}`;
  const currentTime = performance.now();

  if (lastCursorPosition === currentPos && (currentTime - lastCursorTime) < 50) {
    return;
  }

  lastCursorPosition = currentPos;
  lastCursorTime = currentTime;

  const event = {
    type: 'cursorPositionChange',
    data: JSON.stringify({
      lineNumber: e.position.lineNumber,
      column: e.position.column
    })
  };

  const result = await typingProof.recordEvent(event);

  // ログビューアに追加（表示されている場合）
  if (logViewer && logViewer.isVisible) {
    const recordedEvent = typingProof.events[result.index];
    logViewer.addLogEntry(recordedEvent, result.index);
  }

  updateProofStatus();
});

// 選択範囲変更イベントを記録
editor.onDidChangeCursorSelection(async (e) => {
  // イベント記録が無効化されている場合はスキップ
  if (!isEventRecordingEnabled) {
    return;
  }

  // 前回と同じ選択範囲は無視（重複イベント防止）
  // 50ms以内の同一範囲への変更は重複とみなす
  const currentRange = `${e.selection.startLineNumber}:${e.selection.startColumn}-${e.selection.endLineNumber}:${e.selection.endColumn}`;
  const currentTime = performance.now();

  if (lastSelectionRange === currentRange && (currentTime - lastSelectionTime) < 50) {
    return;
  }

  lastSelectionRange = currentRange;
  lastSelectionTime = currentTime;

  // 選択されたテキストを取得
  const model = editor.getModel();
  const selectedText = model.getValueInRange(e.selection);
  const selectionLength = selectedText.length;

  // 選択範囲が空かどうか
  const isEmpty = e.selection.startLineNumber === e.selection.endLineNumber &&
                  e.selection.startColumn === e.selection.endColumn;

  const event = {
    type: 'selectionChange',
    data: JSON.stringify({
      startLineNumber: e.selection.startLineNumber,
      startColumn: e.selection.startColumn,
      endLineNumber: e.selection.endLineNumber,
      endColumn: e.selection.endColumn
    }),
    range: {
      startLineNumber: e.selection.startLineNumber,
      startColumn: e.selection.startColumn,
      endLineNumber: e.selection.endLineNumber,
      endColumn: e.selection.endColumn
    },
    rangeLength: selectionLength,
    selectedText: isEmpty ? null : selectedText,
    description: isEmpty ? '選択解除' : `${selectionLength}文字選択`
  };

  const result = await typingProof.recordEvent(event);

  // ログビューアに追加（表示されている場合）
  if (logViewer && logViewer.isVisible) {
    const recordedEvent = typingProof.events[result.index];
    logViewer.addLogEntry(recordedEvent, result.index);
  }

  updateProofStatus();
});

// 証明ステータスを更新
function updateProofStatus() {
  const stats = typingProof.getStats();
  eventCountEl.textContent = stats.totalEvents;
  currentHashEl.textContent = stats.currentHash.substring(0, 16) + '...';
  currentHashEl.title = stats.currentHash; // フルハッシュをツールチップで表示

  // 100イベントごとにスナップショット記録
  if (stats.totalEvents > 0 && stats.totalEvents % 100 === 0) {
    const editorContent = editor.getValue();
    typingProof.recordContentSnapshot(editorContent)
      .then(result => {
        console.log('[TypedCode] Content snapshot recorded at event', result.index);
      })
      .catch(error => {
        console.error('[TypedCode] Snapshot recording failed:', error);
      });
  }
}


// 証明データのエクスポート機能
const exportProofBtn = document.getElementById('export-proof-btn');
exportProofBtn.addEventListener('click', async () => {
  try {
    const proofData = await typingProof.exportProof();
    const editorContent = editor.getValue();

    // 証明データとコンテンツを含むJSONを生成
    const exportData = {
      ...proofData,
      content: editorContent,
      language: languageSelector.value
    };

    const jsonString = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `typedcode-proof-${timestamp}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    console.log('[TypedCode] Proof exported successfully');
    console.log('Total events:', proofData.proof.totalEvents);
    console.log('Final hash:', proofData.proof.finalHash);
    console.log('Signature:', proofData.proof.signature);

    // 検証を実行
    const verification = await typingProof.verify();
    console.log('[TypedCode] Verification result:', verification);

    if (verification.valid) {
      showNotification('証明データをエクスポートしました（検証: OK）');
    } else {
      showNotification('警告: ハッシュ鎖の検証に失敗しました');
    }
  } catch (error) {
    console.error('[TypedCode] Export failed:', error);
    showNotification('エクスポートに失敗しました');
  }
});

// 初期化処理
async function initializeApp() {
  console.log('[TypedCode] Initializing app...');

  // 永続的なデバイスIDを取得（LocalStorageに保存）
  console.log('[TypedCode] Getting device ID...');
  const deviceId = await Fingerprint.getDeviceId();
  console.log('[TypedCode] Device ID:', deviceId.substring(0, 16) + '...');

  // 詳細なフィンガープリント情報を収集（参考情報として）
  const fingerprintComponents = await Fingerprint.collectComponents();
  const fingerprintHash = await Fingerprint.generate();

  // デバイスIDをメインの識別子として使用
  await typingProof.initialize(deviceId, {
    deviceId,
    fingerprintHash,
    ...fingerprintComponents
  });
  console.log('[TypedCode] TypingProof initialized with device ID');

  // ログビューアの初期化
  const logEntriesContainer = document.getElementById('log-entries');
  if (!logEntriesContainer) {
    console.error('[TypedCode] log-entries not found!');
    return;
  }

  logViewer = new LogViewer(logEntriesContainer, typingProof);
  console.log('[TypedCode] LogViewer initialized');

  // テーマ切り替えボタン
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (themeToggleBtn) {
    // アイコンを更新
    const updateThemeIcon = () => {
      const icon = themeToggleBtn.querySelector('i');
      if (themeManager.isLight()) {
        icon.className = 'fas fa-sun';
      } else {
        icon.className = 'fas fa-moon';
      }
    };

    themeToggleBtn.addEventListener('click', () => {
      themeManager.toggle();
      updateThemeIcon();
    });

    // 初期アイコンを設定
    updateThemeIcon();
  }

  // ログビューアのトグル
  const toggleLogBtn = document.getElementById('toggle-log-btn');
  if (toggleLogBtn) {
    const updateLogButtonText = () => {
      const textSpan = toggleLogBtn.querySelector('span');
      if (textSpan) {
        textSpan.textContent = logViewer.isVisible ? 'ログ非表示' : 'ログ表示';
      }
    };

    toggleLogBtn.addEventListener('click', () => {
      console.log('[TypedCode] Toggle log button clicked');
      logViewer.toggle();
      updateLogButtonText();
    });
    console.log('[TypedCode] Toggle button listener added');
  } else {
    console.error('[TypedCode] toggle-log-btn not found!');
  }

  // ログビューアを閉じる
  const closeLogBtn = document.getElementById('close-log-btn');
  if (closeLogBtn) {
    closeLogBtn.addEventListener('click', () => {
      logViewer.hide();
      const toggleLogBtn = document.getElementById('toggle-log-btn');
      if (toggleLogBtn) {
        const textSpan = toggleLogBtn.querySelector('span');
        if (textSpan) {
          textSpan.textContent = 'ログ表示';
        }
      }
    });
  }

  // ログをクリア
  const clearLogBtn = document.getElementById('clear-log-btn');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      if (confirm('ログをクリアしますか？（証明データは保持されます）')) {
        logViewer.clear();
      }
    });
  }

  const savedContent = localStorage.getItem('editorContent');
  const savedLanguage = localStorage.getItem('editorLanguage');

  // イベント記録を一時的に無効化（初期化時の変更を記録しない）
  isEventRecordingEnabled = false;

  if (savedContent) {
    editor.setValue(savedContent);
  }

  if (savedLanguage) {
    languageSelector.value = savedLanguage;
    const model = editor.getModel();
    monaco.editor.setModelLanguage(model, savedLanguage);
  }

  // イベント記録を再度有効化
  isEventRecordingEnabled = true;

  // 初期コンテンツを記録
  const initialContent = editor.getValue();
  const initialEvent = {
    type: 'editorInitialized',
    data: initialContent,
    rangeLength: initialContent.length,
    range: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: editor.getModel().getLineCount(),
      endColumn: editor.getModel().getLineMaxColumn(editor.getModel().getLineCount())
    },
    description: `エディタ初期化（${initialContent.length}文字）`
  };
  typingProof.recordEvent(initialEvent).then(() => {
    updateProofStatus();
  });

  console.log('[TypedCode] App initialized successfully');
}

// DOMContentLoaded または即座に実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  // DOMが既に読み込まれている場合は即座に実行
  initializeApp();
}

// エディタインスタンスをエクスポート（拡張用）
export { editor, monaco };
