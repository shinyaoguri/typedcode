import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JSZip from 'jszip';
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
  MousePositionData,
  VisibilityChangeData,
  FocusChangeData,
  KeystrokeDynamicsData,
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

// マウス位置追跡用
let lastMousePosition: MousePositionData | null = null;
let lastMouseTime = 0;
const MOUSE_THROTTLE_MS = 100; // マウス移動イベントの間引き間隔

// キーストロークダイナミクス追跡用
const keyDownTimes: Map<string, number> = new Map(); // code -> keyDown時刻
let lastKeyUpTime = 0; // 前回のkeyUp時刻（Flight Time計算用）

// キーストロークダイナミクスの閾値（ノイズ対策）
const KEYSTROKE_THRESHOLDS = {
  MAX_FLIGHT_TIME: 2000,   // Flight Timeの上限（ms）- 2秒以上は異常値
  MAX_DWELL_TIME: 1000,    // Dwell Timeの上限（ms）- 1秒以上は異常値（長押し）
  MIN_DWELL_TIME: 5,       // Dwell Timeの下限（ms）- 5ms未満は計測誤差
  MIN_FLIGHT_TIME: 0,      // Flight Timeの下限（ms）
};

// イベント記録を無効化するフラグ（リセット時などに使用）
let isEventRecordingEnabled = true;

/**
 * イベントを記録（fire-and-forget）
 * PoSW計算を待たずに即座に返り、バックグラウンドで処理
 * ログビューアとステータスは非同期で更新される
 */
function recordEventAsync(event: RecordEventInput): void {
  typingProof.recordEvent(event).then(result => {
    // ログビューアに追加（非同期）
    if (logViewer?.isVisible) {
      const recordedEvent = typingProof.events[result.index];
      if (recordedEvent) {
        logViewer.addLogEntry(recordedEvent, result.index);
      }
    }
    updateProofStatus();
  }).catch(err => {
    console.error('[TypedCode] Event recording failed:', err);
  });
}

// UI要素の取得
const eventCountEl = document.getElementById('event-count');
const currentHashEl = document.getElementById('current-hash');
const blockNotificationEl = document.getElementById('block-notification');
const blockMessageEl = document.getElementById('block-message');

// タブ要素
const editorTab = document.getElementById('editor-tab');
const tabFilename = document.getElementById('tab-filename');
const tabExtension = document.getElementById('tab-extension');
const tabModified = document.getElementById('tab-modified');

// ファイル名の状態
let currentFilename = 'untitled';
let isFileModified = false;

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
  value: '// Hello, TypedCode!',
  language: 'C',
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

// タブの拡張子を更新
function updateTabExtension(language: string): void {
  const ext = '.' + getFileExtension(language);
  if (tabExtension) {
    tabExtension.textContent = ext;
  }
}

// タブの変更状態を更新
function setFileModified(modified: boolean): void {
  isFileModified = modified;
  if (editorTab) {
    if (modified) {
      editorTab.classList.add('modified');
    } else {
      editorTab.classList.remove('modified');
    }
  }
}

// ファイル名編集モードを開始
function startFilenameEdit(): void {
  if (!tabFilename) return;

  const currentName = tabFilename.textContent ?? 'untitled';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-filename-input';
  input.value = currentName;

  const finishEdit = (): void => {
    const newName = input.value.trim() || 'untitled';
    currentFilename = newName;
    tabFilename.textContent = newName;
    tabFilename.style.display = '';
    input.remove();

    // localStorageに保存
    localStorage.setItem('editorFilename', newName);
  };

  input.addEventListener('blur', finishEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = currentFilename;
      input.blur();
    }
  });

  tabFilename.style.display = 'none';
  tabFilename.parentElement?.insertBefore(input, tabFilename);
  input.focus();
  input.select();
}

// タブのダブルクリックでファイル名編集
if (editorTab) {
  editorTab.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startFilenameEdit();
  });
}

// 言語切り替え
const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
if (languageSelector) {
  languageSelector.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    const model = editor.getModel();
    if (model) {
      monaco.editor.setModelLanguage(model, target.value);
    }
    // タブの拡張子を更新
    updateTabExtension(target.value);
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

      recordEventAsync(event);
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
    localStorage.removeItem('editorFilename');

    // ファイル名をリセット
    currentFilename = 'untitled';
    if (tabFilename) tabFilename.textContent = 'untitled';
    setFileModified(false);

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
  const filename = `${currentFilename}.${extension}`;

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  // ダウンロード後は未変更状態に
  setFileModified(false);
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

    recordEventAsync(event);

    if (import.meta.env.DEV) {
      console.log('[TypedCode] Operation detected:', {
        type: operation.inputType,
        description,
        text: operation.text.substring(0, 20) + (operation.text.length > 20 ? '...' : '')
      });
    }
  }

  // ファイル変更を示す
  setFileModified(true);
  updateProofStatus();

  localStorage.setItem('editorContent', editor.getValue());
  if (languageSelector) {
    localStorage.setItem('editorLanguage', languageSelector.value);
  }
});

// カーソル位置変更イベントを記録
editor.onDidChangeCursorPosition(async (e) => {
  // Update status bar cursor position
  const lineEl = document.getElementById('cursor-line');
  const colEl = document.getElementById('cursor-col');
  if (lineEl) lineEl.textContent = String(e.position.lineNumber);
  if (colEl) colEl.textContent = String(e.position.column);

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

  recordEventAsync(event);
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

  recordEventAsync(event);
});

// マウス位置変更イベントを記録（エディタ上のみ）
editorContainer.addEventListener('mousemove', async (e: MouseEvent) => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const currentTime = performance.now();
  if (currentTime - lastMouseTime < MOUSE_THROTTLE_MS) {
    return;
  }

  const mouseData: MousePositionData = {
    x: e.offsetX,
    y: e.offsetY,
    clientX: e.clientX,
    clientY: e.clientY
  };

  // 位置が変わっていない場合はスキップ
  if (lastMousePosition &&
      lastMousePosition.x === mouseData.x &&
      lastMousePosition.y === mouseData.y) {
    return;
  }

  lastMousePosition = mouseData;
  lastMouseTime = currentTime;

  const event: RecordEventInput = {
    type: 'mousePositionChange',
    data: mouseData,
    description: `マウス位置: (${mouseData.x}, ${mouseData.y})`
  };

  recordEventAsync(event);
});

// Visibility変更イベントを記録（タブ切り替えなど）
document.addEventListener('visibilitychange', async () => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const visibilityData: VisibilityChangeData = {
    visible: document.visibilityState === 'visible',
    visibilityState: document.visibilityState
  };

  const event: RecordEventInput = {
    type: 'visibilityChange',
    data: visibilityData,
    description: visibilityData.visible ? 'タブがアクティブになりました' : 'タブが非アクティブになりました'
  };

  recordEventAsync(event);
  console.log('[TypedCode] Visibility changed:', visibilityData.visibilityState);
});

// フォーカス変更イベントを記録（ウィンドウフォーカス）
window.addEventListener('focus', async () => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const focusData: FocusChangeData = {
    focused: true
  };

  const event: RecordEventInput = {
    type: 'focusChange',
    data: focusData,
    description: 'ウィンドウがフォーカスされました'
  };

  recordEventAsync(event);
  console.log('[TypedCode] Window focused');
});

window.addEventListener('blur', async () => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const focusData: FocusChangeData = {
    focused: false
  };

  const event: RecordEventInput = {
    type: 'focusChange',
    data: focusData,
    description: 'ウィンドウがフォーカスを失いました'
  };

  recordEventAsync(event);
  console.log('[TypedCode] Window blurred');
});

// キーストロークダイナミクス: keydownイベントを記録
editorContainer.addEventListener('keydown', async (e: KeyboardEvent) => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const currentTime = performance.now();
  const code = e.code;

  // 既に押されている場合（キーリピート）はスキップ
  if (keyDownTimes.has(code)) {
    return;
  }

  // keyDown時刻を記録
  keyDownTimes.set(code, currentTime);

  // Flight Time計算（前回のkeyUpからの時間）- 閾値でクランプ
  let flightTime: number | undefined;
  if (lastKeyUpTime > 0) {
    const rawFlightTime = currentTime - lastKeyUpTime;
    // 閾値を超える場合はundefined（異常値として記録しない）
    if (rawFlightTime <= KEYSTROKE_THRESHOLDS.MAX_FLIGHT_TIME) {
      flightTime = Math.max(KEYSTROKE_THRESHOLDS.MIN_FLIGHT_TIME, rawFlightTime);
    }
  }

  const keystrokeData: KeystrokeDynamicsData = {
    key: e.key,
    code: code,
    keyDownTime: currentTime,
    flightTime: flightTime,
    modifiers: {
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey
    }
  };

  const event: RecordEventInput = {
    type: 'keyDown',
    data: keystrokeData,
    description: `キー押下: ${e.key}${e.shiftKey ? ' (Shift)' : ''}${e.ctrlKey ? ' (Ctrl)' : ''}${e.altKey ? ' (Alt)' : ''}${e.metaKey ? ' (Meta)' : ''}`
  };

  recordEventAsync(event);
}, { capture: true });

// キーストロークダイナミクス: keyupイベントを記録
editorContainer.addEventListener('keyup', async (e: KeyboardEvent) => {
  if (!isEventRecordingEnabled) {
    return;
  }

  const currentTime = performance.now();
  const code = e.code;

  // Dwell Time計算（keyDownからkeyUpまでの時間）- 閾値でクランプ
  const keyDownTime = keyDownTimes.get(code);
  let dwellTime: number | undefined;
  if (keyDownTime !== undefined) {
    const rawDwellTime = currentTime - keyDownTime;
    // 閾値内の場合のみ有効な値として記録
    if (rawDwellTime >= KEYSTROKE_THRESHOLDS.MIN_DWELL_TIME &&
        rawDwellTime <= KEYSTROKE_THRESHOLDS.MAX_DWELL_TIME) {
      dwellTime = rawDwellTime;
    }
  }

  // keyDownTimeをクリア
  keyDownTimes.delete(code);

  // lastKeyUpTimeを更新（次のFlight Time計算用）
  lastKeyUpTime = currentTime;

  const keystrokeData: KeystrokeDynamicsData = {
    key: e.key,
    code: code,
    dwellTime: dwellTime,
    modifiers: {
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey
    }
  };

  const event: RecordEventInput = {
    type: 'keyUp',
    data: keystrokeData,
    description: `キー離上: ${e.key}${dwellTime !== undefined ? ` (押下時間: ${dwellTime.toFixed(0)}ms)` : ''}`
  };

  recordEventAsync(event);
}, { capture: true });

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

// ZIPでまとめてダウンロード
const exportZipBtn = document.getElementById('export-zip-btn');
exportZipBtn?.addEventListener('click', async () => {
  try {
    const editorContent = editor.getValue();
    const language = languageSelector?.value ?? 'javascript';
    const extension = getFileExtension(language);
    const proofData = await typingProof.exportProof(editorContent);

    const exportData = {
      ...proofData,
      content: editorContent,
      language
    };

    // ZIPファイルを作成
    const zip = new JSZip();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const codeFilename = `${currentFilename}.${extension}`;

    // コードファイルを追加
    zip.file(codeFilename, editorContent);

    // 証明ファイルを追加
    const jsonString = JSON.stringify(exportData, null, 2);
    zip.file(`typedcode-proof-${timestamp}.json`, jsonString);

    // READMEを追加
    const readme = `TypedCode Export
================

This archive contains:
- ${codeFilename}: Your source code
- typedcode-proof-${timestamp}.json: Typing proof data

To verify this proof:
1. Visit the TypedCode verification page
2. Drop the proof JSON file to verify

Generated: ${new Date().toISOString()}
Events: ${proofData.proof.totalEvents}
`;
    zip.file('README.txt', readme);

    // ZIPを生成してダウンロード
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `typedcode-${timestamp}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    const verification = await typingProof.verify();
    if (verification.valid) {
      showNotification('ZIPファイルをダウンロードしました（検証: OK）');
    } else {
      showNotification('警告: ハッシュ鎖の検証に失敗しました');
    }
  } catch (error) {
    console.error('[TypedCode] ZIP export failed:', error);
    showNotification('ZIPエクスポートに失敗しました');
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

  // PoSW状態表示用の要素を取得
  const poswStatusEl = document.getElementById('posw-status');

  await typingProof.initialize(deviceId, {
    deviceId,
    fingerprintHash,
    ...fingerprintComponents
  } as Parameters<typeof typingProof.initialize>[1]);

  // PoSW固定値をステータスバーに表示
  const poswIterations = typingProof.getPoSWIterations();
  if (poswStatusEl) {
    poswStatusEl.textContent = `${poswIterations.toLocaleString()} iter`;
    poswStatusEl.parentElement?.setAttribute('title',
      `PoSW: ${poswIterations.toLocaleString()} iterations per event (fixed)`
    );
  }
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
    // タブの拡張子を更新
    updateTabExtension(savedLanguage);
    console.log('[TypedCode] Restored language from localStorage:', savedLanguage);
  }

  // ファイル名をlocalStorageから復元
  const savedFilename = localStorage.getItem('editorFilename');
  if (savedFilename && tabFilename) {
    currentFilename = savedFilename;
    tabFilename.textContent = savedFilename;
    console.log('[TypedCode] Restored filename from localStorage:', savedFilename);
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
    const updateToggleButtonState = (): void => {
      if (logViewer?.isVisible) {
        toggleLogBtn.classList.add('active');
      } else {
        toggleLogBtn.classList.remove('active');
      }
    };

    toggleLogBtn.addEventListener('click', () => {
      console.log('[TypedCode] Toggle log button clicked');
      logViewer?.toggle();
      updateToggleButtonState();
    });
    console.log('[TypedCode] Toggle button listener added');
  } else {
    console.error('[TypedCode] toggle-log-btn not found!');
  }

  const closeLogBtn = document.getElementById('close-log-btn');
  if (closeLogBtn) {
    closeLogBtn.addEventListener('click', () => {
      logViewer?.hide();
      // Update toggle button state when closed via X button
      const toggleBtn = document.getElementById('toggle-log-btn');
      toggleBtn?.classList.remove('active');
    });
  }

  // ログビューアのリサイズ機能
  const logResizeHandle = document.getElementById('log-resize-handle');
  const logViewerEl = document.getElementById('log-viewer');
  const mainEl = document.querySelector('main');

  if (logResizeHandle && logViewerEl && editorContainer && mainEl) {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    logResizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      isResizing = true;
      startX = e.clientX;
      startWidth = logViewerEl.offsetWidth;

      // リサイズ中はトランジションを無効化
      logViewerEl.classList.add('resizing');
      editorContainer.classList.add('resizing');
      logResizeHandle.classList.add('dragging');

      // body全体でカーソルを変更
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!isResizing) return;

      const mainWidth = mainEl.clientWidth;
      const deltaX = startX - e.clientX;
      const newWidth = startWidth + deltaX;

      // 最小幅200px、最大幅は画面の70%
      const minWidth = 200;
      const maxWidth = mainWidth * 0.7;
      const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));

      // パーセンテージを計算
      const widthPercent = (clampedWidth / mainWidth) * 100;

      // flexで幅を設定
      logViewerEl.style.flex = `0 0 ${widthPercent}%`;
      editorContainer.style.flex = `1 1 ${100 - widthPercent}%`;
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;

      isResizing = false;

      // トランジションを再有効化
      logViewerEl.classList.remove('resizing');
      editorContainer.classList.remove('resizing');
      logResizeHandle.classList.remove('dragging');

      // カーソルを元に戻す
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
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
