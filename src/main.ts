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
import type {
  MonacoEditor,
  CursorPosition,
  RecordEventInput,
  DetectedEvent,
} from './types.js';

// Monaco Editor の Worker 設定
declare const self: Window & typeof globalThis & { MonacoEnvironment: monaco.Environment };

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

// タイピング証明システムの初期化
const typingProof = new TypingProof();

// 操作検出器の初期化
const operationDetector = new OperationDetector();

// ログビューアの初期化（DOMContentLoaded後に行う）
let logViewer: LogViewer | null = null;

// 前回のカーソル位置を記録（重複イベント防止用）
let lastCursorPosition: string | null = null;
let lastCursorTime = 0;
let lastSelectionRange: string | null = null;
let lastSelectionTime = 0;

// イベント記録を無効化するフラグ（リセット時などに使用）
let isEventRecordingEnabled = true;

// UI要素の取得
const eventCountEl = document.getElementById('event-count');
const currentHashEl = document.getElementById('current-hash');
const blockNotificationEl = document.getElementById('block-notification');
const blockMessageEl = document.getElementById('block-message');

// 通知を表示
function showNotification(message: string): void {
  if (blockMessageEl) blockMessageEl.textContent = message;
  blockNotificationEl?.classList.remove('hidden');

  setTimeout(() => {
    blockNotificationEl?.classList.add('hidden');
  }, 2000);
}

// エディタの初期化
const editorContainer = document.getElementById('editor');
if (!editorContainer) {
  throw new Error('Editor container not found');
}

const editor: MonacoEditor = monaco.editor.create(editorContainer, {
  value: '// TypedCode へようこそ！\n// 手動のタイピングを証明するエディタです\n// コピペや自動入力を検出して記録します\n\n#include<stdio.h>\n int main() {\n  printf("Hello, World!");\n  return 0;\n}\n',
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

// NOTE: 初期コンテンツの記録は initializeApp() 内で typingProof.initialize() の後に実行される

// 言語切り替え
const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
if (languageSelector) {
  languageSelector.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, target.value);
    }
  });
}

// 入力検出器の初期化
new InputDetector(document.body, async (detectedEvent: DetectedEvent) => {
  showNotification(detectedEvent.message);
  console.log('[TypedCode] Detected operation:', detectedEvent);

  // コピペやドロップをログに記録
  if (detectedEvent.type === 'paste' || detectedEvent.type === 'drop') {
    const position: CursorPosition | null = editor.getPosition();

    if (position) {
      const event: RecordEventInput = {
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
      if (logViewer?.isVisible) {
        const recordedEvent = typingProof.events[result.index];
        if (recordedEvent) {
          logViewer.addLogEntry(recordedEvent, result.index);
        }
      }

      updateProofStatus();
    }
  }
});

// リセット機能
const resetBtn = document.getElementById('reset-btn');
resetBtn?.addEventListener('click', async () => {
  if (confirm('エディタの内容と操作ログを全て削除してリセットしますか？\nこの操作は取り消せません。')) {
    isEventRecordingEnabled = false;

    await typingProof.reset();

    if (logViewer) {
      logViewer.clear();
    }

    localStorage.removeItem('editorContent');

    updateProofStatus();

    editor.setValue('');

    isEventRecordingEnabled = true;

    showNotification('リセットしました');
  }
});

// ダウンロード機能
const downloadBtn = document.getElementById('download-btn');
downloadBtn?.addEventListener('click', () => {
  const content = editor.getValue();
  const language = languageSelector?.value ?? 'javascript';
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
function getFileExtension(language: string): string {
  const extensions: Record<string, string> = {
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
  return extensions[language] ?? 'txt';
}

// エディタの変更イベントを監視してタイピング証明を記録
editor.onDidChangeModelContent(async (e) => {
  if (!isEventRecordingEnabled) {
    return;
  }

  for (const change of e.changes) {
    const operation = operationDetector.detectOperationType(change, e);
    const description = operationDetector.getOperationDescription(operation);

    const event: RecordEventInput = {
      type: 'contentChange',
      inputType: operation.inputType,
      data: operation.text,
      rangeOffset: operation.rangeOffset,
      rangeLength: operation.rangeLength,
      range: operation.range,
      isMultiLine: operation.isMultiLine,
      description: description,
      ...(operation.deletedLength && { deletedLength: operation.deletedLength }),
      ...(operation.insertedText && { insertedText: operation.insertedText }),
      ...(operation.insertLength && { insertLength: operation.insertLength }),
      ...(operation.deleteDirection && { deleteDirection: operation.deleteDirection })
    };

    const result = await typingProof.recordEvent(event);

    if (logViewer?.isVisible) {
      const recordedEvent = typingProof.events[result.index];
      if (recordedEvent) {
        logViewer.addLogEntry(recordedEvent, result.index);
      }
    }

    if (import.meta.env.DEV) {
      console.log('[TypedCode] Operation detected:', {
        type: operation.inputType,
        description,
        text: operation.text.substring(0, 20) + (operation.text.length > 20 ? '...' : '')
      });
    }
  }

  updateProofStatus();

  localStorage.setItem('editorContent', editor.getValue());
  if (languageSelector) {
    localStorage.setItem('editorLanguage', languageSelector.value);
  }
});

// カーソル位置変更イベントを記録
editor.onDidChangeCursorPosition(async (e) => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const currentPos = `${e.position.lineNumber}:${e.position.column}`;
  const currentTime = performance.now();

  if (lastCursorPosition === currentPos && (currentTime - lastCursorTime) < 50) {
    return;
  }

  lastCursorPosition = currentPos;
  lastCursorTime = currentTime;

  const event: RecordEventInput = {
    type: 'cursorPositionChange',
    data: {
      lineNumber: e.position.lineNumber,
      column: e.position.column
    }
  };

  const result = await typingProof.recordEvent(event);

  if (logViewer?.isVisible) {
    const recordedEvent = typingProof.events[result.index];
    if (recordedEvent) {
      logViewer.addLogEntry(recordedEvent, result.index);
    }
  }

  updateProofStatus();
});

// 選択範囲変更イベントを記録
editor.onDidChangeCursorSelection(async (e) => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const currentRange = `${e.selection.startLineNumber}:${e.selection.startColumn}-${e.selection.endLineNumber}:${e.selection.endColumn}`;
  const currentTime = performance.now();

  if (lastSelectionRange === currentRange && (currentTime - lastSelectionTime) < 50) {
    return;
  }

  lastSelectionRange = currentRange;
  lastSelectionTime = currentTime;

  const model = editor.getModel();
  const selectedText = model?.getValueInRange(e.selection) ?? '';
  const selectionLength = selectedText.length;

  const isEmpty = e.selection.startLineNumber === e.selection.endLineNumber &&
                  e.selection.startColumn === e.selection.endColumn;

  const event: RecordEventInput = {
    type: 'selectionChange',
    data: {
      startLineNumber: e.selection.startLineNumber,
      startColumn: e.selection.startColumn,
      endLineNumber: e.selection.endLineNumber,
      endColumn: e.selection.endColumn
    },
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

  if (logViewer?.isVisible) {
    const recordedEvent = typingProof.events[result.index];
    if (recordedEvent) {
      logViewer.addLogEntry(recordedEvent, result.index);
    }
  }

  updateProofStatus();
});

// 証明ステータスを更新
function updateProofStatus(): void {
  const stats = typingProof.getStats();
  if (eventCountEl) eventCountEl.textContent = String(stats.totalEvents);
  if (currentHashEl && stats.currentHash) {
    currentHashEl.textContent = stats.currentHash.substring(0, 16) + '...';
    currentHashEl.title = stats.currentHash;
  }

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
exportProofBtn?.addEventListener('click', async () => {
  try {
    const editorContent = editor.getValue();
    const proofData = await typingProof.exportProof(editorContent);

    const exportData = {
      ...proofData,
      content: editorContent,
      language: languageSelector?.value ?? 'javascript'
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
async function initializeApp(): Promise<void> {
  console.log('[TypedCode] Initializing app...');

  console.log('[TypedCode] Getting device ID...');
  const deviceId = await Fingerprint.getDeviceId();
  console.log('[TypedCode] Device ID:', deviceId.substring(0, 16) + '...');

  const fingerprintComponents = await Fingerprint.collectComponents();
  const fingerprintHash = await Fingerprint.generate();

  await typingProof.initialize(deviceId, {
    deviceId,
    fingerprintHash,
    ...fingerprintComponents
  } as Parameters<typeof typingProof.initialize>[1]);
  console.log('[TypedCode] TypingProof initialized with device ID');

  const savedContent = localStorage.getItem('editorContent');
  const savedLanguage = localStorage.getItem('editorLanguage');

  isEventRecordingEnabled = false;

  if (savedContent) {
    editor.setValue(savedContent);
    console.log('[TypedCode] Restored content from localStorage');
  }

  if (savedLanguage && languageSelector) {
    languageSelector.value = savedLanguage;
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, savedLanguage);
    }
    console.log('[TypedCode] Restored language from localStorage:', savedLanguage);
  }

  const initialContent = editor.getValue();
  console.log('[TypedCode] Recording initial content, length:', initialContent.length);

  if (initialContent?.trim()) {
    const result = await typingProof.recordEvent({
      type: 'contentSnapshot',
      data: initialContent,
      description: '初期コンテンツ',
      isSnapshot: true
    });
    updateProofStatus();
    console.log('[TypedCode] Initial content recorded as event', result.index, 'with hash:', result.hash.substring(0, 16) + '...');
  } else {
    console.log('[TypedCode] No initial content to record');
  }

  isEventRecordingEnabled = true;
  console.log('[TypedCode] Event recording enabled');

  const logEntriesContainer = document.getElementById('log-entries');
  if (!logEntriesContainer) {
    console.error('[TypedCode] log-entries not found!');
    return;
  }

  logViewer = new LogViewer(logEntriesContainer, typingProof);
  console.log('[TypedCode] LogViewer initialized');

  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (themeToggleBtn) {
    const updateThemeIcon = (): void => {
      const icon = themeToggleBtn.querySelector('i');
      if (icon) {
        icon.className = themeManager.isLight() ? 'fas fa-sun' : 'fas fa-moon';
      }
    };

    themeToggleBtn.addEventListener('click', () => {
      themeManager.toggle();
      updateThemeIcon();
    });

    updateThemeIcon();
  }

  const toggleLogBtn = document.getElementById('toggle-log-btn');
  if (toggleLogBtn) {
    const updateLogButtonText = (): void => {
      const textSpan = toggleLogBtn.querySelector('span');
      if (textSpan && logViewer) {
        textSpan.textContent = logViewer.isVisible ? 'ログ非表示' : 'ログ表示';
      }
    };

    toggleLogBtn.addEventListener('click', () => {
      console.log('[TypedCode] Toggle log button clicked');
      logViewer?.toggle();
      updateLogButtonText();
    });
    console.log('[TypedCode] Toggle button listener added');
  } else {
    console.error('[TypedCode] toggle-log-btn not found!');
  }

  const closeLogBtn = document.getElementById('close-log-btn');
  if (closeLogBtn) {
    closeLogBtn.addEventListener('click', () => {
      logViewer?.hide();
      const toggleLogBtnInner = document.getElementById('toggle-log-btn');
      if (toggleLogBtnInner) {
        const textSpan = toggleLogBtnInner.querySelector('span');
        if (textSpan) {
          textSpan.textContent = 'ログ表示';
        }
      }
    });
  }

  const clearLogBtn = document.getElementById('clear-log-btn');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      if (confirm('ログをクリアしますか？（証明データは保持されます）')) {
        logViewer?.clear();
      }
    });
  }

  const copyCodeBtn = document.getElementById('copy-code-btn');
  copyCodeBtn?.addEventListener('click', async () => {
    try {
      const code = editor.getValue();
      await navigator.clipboard.writeText(code);

      copyCodeBtn.classList.add('copied');

      showNotification('コードをコピーしました！');

      setTimeout(() => {
        copyCodeBtn.classList.remove('copied');
      }, 2000);
    } catch (error) {
      console.error('[TypedCode] Copy failed:', error);
      showNotification('コピーに失敗しました');
    }
  });

  console.log('[TypedCode] App initialized successfully');
}

// DOMContentLoaded または即座に実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void initializeApp());
} else {
  void initializeApp();
}

// エディタインスタンスをエクスポート（拡張用）
export { editor, monaco };
