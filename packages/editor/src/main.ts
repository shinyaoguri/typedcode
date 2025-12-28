import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JSZip from 'jszip';
import './styles/main.css';
import { Fingerprint } from '@typedcode/shared';
import type {
  CursorPosition,
  RecordEventInput,
  DetectedEvent,
  MousePositionData,
  VisibilityChangeData,
  FocusChangeData,
  KeystrokeDynamicsData,
  WindowSizeData,
} from '@typedcode/shared';
import { InputDetector } from './tracking/InputDetector.js';
import { OperationDetector } from './tracking/OperationDetector.js';
import { LogViewer } from './ui/components/LogViewer.js';
import { ThemeManager } from './editor/ThemeManager.js';
import { TabManager, type TabState } from './ui/tabs/TabManager.js';
import type { MonacoEditor } from './editor/types.js';
import {
  isTurnstileConfigured,
  loadTurnstileScript as preloadTurnstile,
  performTurnstileVerification,
} from './services/TurnstileService.js';
import { CTerminal } from './terminal/CTerminal.js';
import { getCExecutor, type ParsedError } from './executors/c/CExecutor.js';
import { getCppExecutor } from './executors/cpp/CppExecutor.js';
import { getJavaScriptExecutor } from './executors/javascript/JavaScriptExecutor.js';
import { getTypeScriptExecutor } from './executors/typescript/TypeScriptExecutor.js';
import { getPythonExecutor } from './executors/python/PythonExecutor.js';
import type { ILanguageExecutor } from './executors/interfaces/ILanguageExecutor.js';
import '@xterm/xterm/css/xterm.css';

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

// 操作検出器の初期化
const operationDetector = new OperationDetector();

// TabManager（initializeApp後に初期化）
let tabManager: TabManager | null = null;

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

// ウィンドウサイズ追跡用
let lastWindowSize: WindowSizeData | null = null;
let windowResizeTimeout: ReturnType<typeof setTimeout> | null = null;
const WINDOW_RESIZE_DEBOUNCE_MS = 500; // リサイズイベントのデバウンス間隔

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

// ページ離脱確認を無効化するフラグ（リセット時に使用）
let skipBeforeUnload = false;

// アプリ初期化完了フラグ（tabManager初期化前のイベント記録を防止）
let isAppInitialized = false;

// ターミナル・実行環境
let cTerminal: CTerminal | null = null;
let isRunningCode = false;

// 利用規約関連
const TERMS_ACCEPTED_KEY = 'typedcode-terms-accepted';
const TERMS_VERSION = '1.0';  // バージョン管理（規約変更時に再同意を求める）

// ランタイム状態管理
type RuntimeState = 'not-ready' | 'loading' | 'ready';

// 実行可能な言語のランタイム状態
const runtimeStatus: Record<string, RuntimeState> = {
  c: 'not-ready',
  cpp: 'not-ready',
  javascript: 'ready',  // ブラウザ内蔵なので常にready
  typescript: 'ready',  // ブラウザ内蔵なので常にready
  python: 'not-ready',
};

// 言語ごとのランタイム表示名
const runtimeDisplayNames: Record<string, string> = {
  c: 'Clang',
  cpp: 'Clang',
  javascript: 'Browser JS',
  typescript: 'TS Compiler',
  python: 'Pyodide',
};

// 共通の注意書き
const EXECUTION_DISCLAIMER = '※ ブラウザ上の簡易実行環境です。ローカル環境と動作が異なる場合があります。';

/**
 * 言語ごとのターミナル説明を取得
 */
function getLanguageDescription(language: string): string[] {
  switch (language) {
    case 'c':
      return [
        'TypedCode Terminal - C 実行環境',
        'Clang (WASM) でコンパイル・実行',
        '標準入出力対応 | タイムアウトなし',
        EXECUTION_DISCLAIMER,
      ];
    case 'cpp':
      return [
        'TypedCode Terminal - C++ 実行環境',
        'Clang (WASM) でコンパイル・実行 | C++17対応',
        '標準入出力対応 | タイムアウトなし',
        EXECUTION_DISCLAIMER,
      ];
    case 'javascript':
      return [
        'TypedCode Terminal - JavaScript 実行環境',
        'ブラウザ内蔵エンジンで実行 | top-level await対応',
        'console.log で出力 | 30秒タイムアウト',
        EXECUTION_DISCLAIMER,
      ];
    case 'typescript':
      return [
        'TypedCode Terminal - TypeScript 実行環境',
        'トランスパイル後にブラウザで実行 | 型チェックなし',
        'console.log で出力 | 30秒タイムアウト',
        EXECUTION_DISCLAIMER,
      ];
    case 'python':
      return [
        'TypedCode Terminal - Python 実行環境',
        'Pyodide (CPython WASM) で実行 |',
        'NumPy/Pandas等は自動インストール | 60秒タイムアウト',
        EXECUTION_DISCLAIMER,
      ];
    default:
      return [
        'TypedCode Terminal',
        'Ctrl+Enter または Run ボタンでコードを実行',
        EXECUTION_DISCLAIMER,
      ];
  }
}

/**
 * ターミナルに言語説明を表示
 */
function showLanguageDescriptionInTerminal(language: string): void {
  if (!cTerminal) return;
  cTerminal.clear();
  const langDesc = getLanguageDescription(language);
  for (const line of langDesc) {
    cTerminal.writeLine(line);
  }
  cTerminal.writeLine('');
}

/**
 * 利用規約に同意済みかチェック
 */
function hasAcceptedTerms(): boolean {
  const accepted = localStorage.getItem(TERMS_ACCEPTED_KEY);
  if (!accepted) return false;
  try {
    const data = JSON.parse(accepted);
    return data.version === TERMS_VERSION;
  } catch {
    return false;
  }
}

/**
 * 利用規約モーダルを表示
 */
async function showTermsModal(): Promise<void> {
  const termsModal = document.getElementById('terms-modal');
  const termsAgreeCheckbox = document.getElementById('terms-agree-checkbox') as HTMLInputElement | null;
  const termsAgreeBtn = document.getElementById('terms-agree-btn') as HTMLButtonElement | null;

  if (!termsModal || !termsAgreeCheckbox || !termsAgreeBtn) {
    console.error('[TypedCode] Terms modal elements not found');
    return;
  }

  return new Promise((resolve) => {
    termsModal.classList.remove('hidden');

    const handleCheckboxChange = (): void => {
      termsAgreeBtn.disabled = !termsAgreeCheckbox.checked;
    };

    const handleAgree = (): void => {
      const timestamp = Date.now();

      // localStorageに保存
      localStorage.setItem(TERMS_ACCEPTED_KEY, JSON.stringify({
        version: TERMS_VERSION,
        timestamp,
        agreedAt: new Date(timestamp).toISOString()
      }));

      // イベントリスナーをクリーンアップ
      termsAgreeCheckbox.removeEventListener('change', handleCheckboxChange);
      termsAgreeBtn.removeEventListener('click', handleAgree);

      termsModal.classList.add('hidden');
      console.log('[TypedCode] Terms accepted at', new Date(timestamp).toISOString());
      resolve();
    };

    termsAgreeCheckbox.addEventListener('change', handleCheckboxChange);
    termsAgreeBtn.addEventListener('click', handleAgree);
  });
}

/**
 * ランタイム状態を更新
 */
function updateRuntimeStatus(language: string, state: RuntimeState): void {
  runtimeStatus[language] = state;
  // C++はCと同じランタイム（Clang）を共有
  if (language === 'c') {
    runtimeStatus['cpp'] = state;
  }
  // 現在選択中の言語の場合、インジケーターも更新
  const currentLanguage = (document.getElementById('language-selector') as HTMLSelectElement)?.value;
  if (currentLanguage === language || (language === 'c' && currentLanguage === 'cpp')) {
    updateLanguageRuntimeIndicator(currentLanguage);
  }
}

/**
 * 言語セレクタ横のランタイムインジケーターを更新
 */
function updateLanguageRuntimeIndicator(language: string): void {
  const indicator = document.getElementById('runtime-state-indicator');
  if (!indicator) return;

  const state = runtimeStatus[language] || 'not-ready';
  const displayName = runtimeDisplayNames[language] || '';

  // 実行非対応言語（HTML, CSS等）の場合は非表示
  if (!displayName) {
    indicator.textContent = '';
    indicator.className = 'runtime-state-indicator';
    return;
  }

  // 状態クラスを更新
  indicator.className = `runtime-state-indicator ${state}`;

  // 表示テキストを更新
  const stateText: Record<RuntimeState, string> = {
    'not-ready': `${displayName}`,
    'loading': `${displayName} Loading...`,
    'ready': `${displayName} ✓`
  };
  indicator.textContent = stateText[state];
}

/**
 * C言語実行環境をバックグラウンドで初期化
 * エディタの操作をブロックせずに非同期でダウンロード
 */
async function initializeCRuntimeInBackground(): Promise<void> {
  // 既にreadyなら何もしない
  if (runtimeStatus['c'] === 'ready') {
    console.log('[TypedCode] C runtime already initialized');
    return;
  }

  // loadingなら既に初期化中
  if (runtimeStatus['c'] === 'loading') {
    console.log('[TypedCode] C runtime initialization already in progress');
    return;
  }

  console.log('[TypedCode] Starting background C runtime initialization...');
  updateRuntimeStatus('c', 'loading');

  try {
    const executor = getCExecutor();
    await executor.initialize((progress) => {
      console.log('[TypedCode] C runtime:', progress.message);
      // ステータスバーのインジケーターは updateRuntimeStatus で既に 'loading' になっている
    });

    updateRuntimeStatus('c', 'ready');
    console.log('[TypedCode] C runtime initialization complete');
  } catch (error) {
    console.error('[TypedCode] C runtime initialization failed:', error);
    // 失敗時は not-ready に戻す
    updateRuntimeStatus('c', 'not-ready');
  }
}

/**
 * 現在のウィンドウサイズを取得
 */
function getCurrentWindowSize(): WindowSizeData {
  return {
    width: window.outerWidth,
    height: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    screenX: window.screenX,
    screenY: window.screenY
  };
}

/**
 * ウィンドウサイズが変更されたかチェック
 */
function hasWindowSizeChanged(current: WindowSizeData, previous: WindowSizeData | null): boolean {
  if (!previous) return true;
  return (
    current.width !== previous.width ||
    current.height !== previous.height ||
    current.innerWidth !== previous.innerWidth ||
    current.innerHeight !== previous.innerHeight ||
    current.devicePixelRatio !== previous.devicePixelRatio ||
    current.screenX !== previous.screenX ||
    current.screenY !== previous.screenY
  );
}

/**
 * ウィンドウリサイズイベントを記録
 */
function recordWindowResize(isInitial: boolean = false): void {
  if (!isEventRecordingEnabled) return;

  const currentSize = getCurrentWindowSize();

  // サイズが変わっていない場合はスキップ
  if (!hasWindowSizeChanged(currentSize, lastWindowSize)) {
    return;
  }

  lastWindowSize = currentSize;

  const event: RecordEventInput = {
    type: 'windowResize',
    data: currentSize,
    description: isInitial
      ? `初期ウィンドウサイズ: ${currentSize.innerWidth}x${currentSize.innerHeight}`
      : `ウィンドウリサイズ: ${currentSize.innerWidth}x${currentSize.innerHeight}`
  };

  recordEventAsync(event);
}

/**
 * イベントを記録（fire-and-forget）
 * PoSW計算を待たずに即座に返り、バックグラウンドで処理
 * ログビューアとステータスは非同期で更新される
 */
function recordEventAsync(event: RecordEventInput): void {
  // 初期化完了前のイベント記録をスキップ
  if (!isAppInitialized) {
    console.debug('[TypedCode] Skipping event - app not initialized');
    return;
  }

  const activeProof = tabManager?.getActiveProof();
  if (!activeProof) return;

  activeProof.recordEvent(event).then(result => {
    // ログビューアに追加（非同期）
    if (logViewer?.isVisible) {
      const recordedEvent = activeProof.events[result.index];
      if (recordedEvent) {
        logViewer.addLogEntry(recordedEvent, result.index);
      }
    }
    // タブデータを保存
    tabManager?.saveToStorage();
  }).catch(err => {
    console.error('[TypedCode] Event recording failed:', err);
    // ユーザーに通知（初期化エラーなど重大なエラーの場合）
    if (err instanceof Error && err.message.includes('not initialized')) {
      showNotification('イベント記録エラー: 初期化が完了していません');
    }
  }).finally(() => {
    // 成功・失敗に関わらずステータスを更新
    updateProofStatus();
  });
}

// UI要素の取得
const eventCountEl = document.getElementById('event-count');
const currentHashEl = document.getElementById('current-hash');
const proofStatusItemEl = document.getElementById('proof-status-item');
const proofProgressRing = document.getElementById('proof-progress-ring');
const progressBar = document.getElementById('progress-bar') as SVGCircleElement | null;
const blockNotificationEl = document.getElementById('block-notification');
const blockMessageEl = document.getElementById('block-message');

// プログレスリング用の状態管理
let peakPendingCount = 0;  // 処理開始時のキュー数（ピーク値）
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * 8;  // 円周 = 2πr (r=8)

// タブ要素
const editorTabsContainer = document.getElementById('editor-tabs');
const addTabBtn = document.getElementById('add-tab-btn');

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
  value: '',
  language: 'c',
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

// SVGアイコンがある言語のリスト
const LANGUAGES_WITH_SVG_ICON = ['c', 'cpp', 'javascript', 'typescript', 'html', 'css', 'python'];

// ベースパスを取得（Viteのbase設定を反映）
const BASE_PATH = import.meta.env.BASE_URL;

// タブUIを生成
function createTabElement(tab: TabState): HTMLElement {
  const tabEl = document.createElement('div');
  tabEl.className = 'editor-tab';
  tabEl.dataset.tabId = tab.id;

  if (tabManager?.getActiveTab()?.id === tab.id) {
    tabEl.classList.add('active');
  }
  const ext = '.' + getFileExtension(tab.language);

  // SVGアイコンがあればimgタグ、なければFont Awesomeのデフォルトアイコン
  const hasSvgIcon = LANGUAGES_WITH_SVG_ICON.includes(tab.language);
  const iconHtml = hasSvgIcon
    ? `<img src="${BASE_PATH}icons/${tab.language}.svg" class="tab-icon" alt="${tab.language}" />`
    : `<i class="fas fa-file-code tab-icon"></i>`;

  // 認証状態のインジケーター（さりげなく表示）
  let verificationIndicator = '';
  if (tab.verificationState === 'verified') {
    const timestamp = tab.verificationDetails?.timestamp
      ? new Date(tab.verificationDetails.timestamp).toLocaleString('ja-JP')
      : '';
    const tooltip = timestamp
      ? `✓ 人間認証済み\n認証日時: ${timestamp}`
      : '✓ 人間認証済み';
    verificationIndicator = `<span class="tab-verification verified" title="${tooltip}"></span>`;
  } else if (tab.verificationState === 'failed') {
    const timestamp = tab.verificationDetails?.timestamp
      ? new Date(tab.verificationDetails.timestamp).toLocaleString('ja-JP')
      : '';
    const reason = tab.verificationDetails?.failureReason;
    const reasonText = reason === 'timeout' ? 'タイムアウト'
      : reason === 'network_error' ? 'ネットワークエラー'
      : reason === 'challenge_failed' ? 'チャレンジ失敗'
      : reason === 'token_acquisition_failed' ? 'トークン取得失敗'
      : '不明なエラー';
    const tooltip = `✗ 認証失敗\n理由: ${reasonText}${timestamp ? `\n日時: ${timestamp}` : ''}`;
    verificationIndicator = `<span class="tab-verification failed" title="${tooltip}"></span>`;
  }

  tabEl.innerHTML = `
    ${iconHtml}
    <span class="tab-filename">${tab.filename}</span>
    <span class="tab-extension">${ext}</span>
    ${verificationIndicator}
    <button class="tab-close-btn" title="Close Tab"><i class="fas fa-times"></i></button>
  `;

  // タブクリックで切り替え
  tabEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // 閉じるボタンのクリックは除外
    if (target.closest('.tab-close-btn')) return;
    // ファイル名クリックは編集モードに（アクティブタブの場合のみ）
    if (target.closest('.tab-filename') || target.closest('.tab-extension')) {
      if (tabManager?.getActiveTab()?.id === tab.id) {
        e.stopPropagation();
        startFilenameEdit(tabEl, tab.id);
        return;
      }
    }
    tabManager?.switchTab(tab.id);
  });

  // 閉じるボタン
  const closeBtn = tabEl.querySelector('.tab-close-btn');
  closeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tabManager?.getTabCount() === 1) {
      showNotification('最後のタブは閉じられません');
      return;
    }
    const targetTab = tabManager?.getTab(tab.id);
    const tabName = targetTab ? `${targetTab.filename}.${getFileExtension(targetTab.language)}` : 'このタブ';
    if (confirm(`「${tabName}」を閉じますか？\n記録された操作ログも削除されます。`)) {
      tabManager?.closeTab(tab.id);
    }
  });

  return tabEl;
}

// タブUIを更新
function updateTabUI(): void {
  if (!editorTabsContainer || !tabManager) return;

  // 全タブを再生成
  editorTabsContainer.innerHTML = '';
  for (const tab of tabManager.getAllTabs()) {
    const tabEl = createTabElement(tab);
    editorTabsContainer.appendChild(tabEl);
  }
}

// ファイル名編集モードを開始
function startFilenameEdit(tabEl: HTMLElement, tabId: string): void {
  const filenameSpan = tabEl.querySelector('.tab-filename') as HTMLElement | null;
  if (!filenameSpan) return;

  const tab = tabManager?.getTab(tabId);
  if (!tab) return;

  const currentName = tab.filename;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-filename-input';
  input.value = currentName;

  const finishEdit = (): void => {
    const newName = input.value.trim() || 'untitled';
    tabManager?.renameTab(tabId, newName);
    filenameSpan.textContent = newName;
    filenameSpan.style.display = '';
    input.remove();
  };

  input.addEventListener('blur', finishEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = currentName;
      input.blur();
    }
  });

  filenameSpan.style.display = 'none';
  filenameSpan.parentElement?.insertBefore(input, filenameSpan);
  input.focus();
  input.select();
}

// 言語切り替え
const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
if (languageSelector) {
  languageSelector.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    const activeTab = tabManager?.getActiveTab();
    if (activeTab) {
      tabManager?.setTabLanguage(activeTab.id, target.value);
      updateTabUI();
      // 言語切り替え時にターミナルに説明を表示
      showLanguageDescriptionInTerminal(target.value);
      // ランタイムインジケーターを更新
      updateLanguageRuntimeIndicator(target.value);
    }
  });
}

// 次の Untitled 番号を取得
function getNextUntitledNumber(): number {
  if (!tabManager) return 1;
  const tabs = tabManager.getAllTabs();
  const untitledNumbers: number[] = [];
  for (const tab of tabs) {
    const match = tab.filename.match(/^Untitled-(\d+)$/i);
    if (match) {
      untitledNumbers.push(parseInt(match[1]!, 10));
    }
  }
  if (untitledNumbers.length === 0) return 1;
  return Math.max(...untitledNumbers) + 1;
}

// 新規タブ追加ボタン
addTabBtn?.addEventListener('click', async () => {
  if (!tabManager) return;

  // Turnstile設定時は認証中メッセージを表示
  if (isTurnstileConfigured()) {
    showNotification('人間認証を実行中...');
  }

  const num = getNextUntitledNumber();
  const newTab = await tabManager.createTab(`Untitled-${num}`, 'c', '');

  if (!newTab) {
    // Turnstile失敗時
    showNotification('認証に失敗しました。もう一度お試しください。');
    return;
  }

  await tabManager.switchTab(newTab.id);
  showNotification('新しいタブを作成しました');
});

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
const resetDialog = document.getElementById('reset-dialog');
const resetCancelBtn = document.getElementById('reset-cancel-btn');
const resetConfirmBtn = document.getElementById('reset-confirm-btn');

// ダイアログを表示
resetBtn?.addEventListener('click', () => {
  // ドロップダウンを閉じる
  document.getElementById('settings-dropdown')?.classList.remove('visible');
  // ダイアログを表示
  resetDialog?.classList.remove('hidden');
});

// キャンセル
resetCancelBtn?.addEventListener('click', () => {
  resetDialog?.classList.add('hidden');
});

// オーバーレイクリックでキャンセル
resetDialog?.addEventListener('click', (e) => {
  if (e.target === resetDialog) {
    resetDialog.classList.add('hidden');
  }
});

// ESCキーでキャンセル
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !resetDialog?.classList.contains('hidden')) {
    resetDialog?.classList.add('hidden');
  }
});

// リセット実行
resetConfirmBtn?.addEventListener('click', () => {
  // ダイアログを閉じる
  resetDialog?.classList.add('hidden');

  // localStorageを完全にクリア
  localStorage.clear();

  // beforeunloadを無効化してリロード
  skipBeforeUnload = true;
  window.location.reload();
});

// ページ離脱時の確認ダイアログ（VSCode風）
window.addEventListener('beforeunload', (e) => {
  // リセット時はスキップ
  if (skipBeforeUnload) return;

  // データがある場合のみ確認
  const activeProof = tabManager?.getActiveProof();
  if (activeProof && activeProof.events.length > 0) {
    e.preventDefault();
  }
});

// ダウンロード機能（アクティブタブのコードのみ）
const downloadBtn = document.getElementById('download-btn');
downloadBtn?.addEventListener('click', () => {
  const activeTab = tabManager?.getActiveTab();
  if (!activeTab) return;

  const content = activeTab.model.getValue();
  const extension = getFileExtension(activeTab.language);
  const filename = `${activeTab.filename}.${extension}`;

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

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

  updateProofStatus();

  // タブデータを保存（recordEventAsyncでも保存しているが、念のため）
  tabManager?.saveToStorage();
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
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY
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
  const activeProof = tabManager?.getActiveProof();
  if (!activeProof) return;

  const stats = activeProof.getStats();
  if (eventCountEl) eventCountEl.textContent = String(stats.totalEvents);
  if (currentHashEl && stats.currentHash) {
    currentHashEl.textContent = stats.currentHash.substring(0, 16) + '...';
    currentHashEl.title = stats.currentHash;
  }

  // 待ち行列状況を円形プログレスゲージで表示
  if (proofProgressRing && progressBar) {
    if (stats.pendingCount > 0) {
      // 処理中: プログレスリングを表示
      proofProgressRing.classList.add('processing');

      // ピーク値を更新（キューが増えた場合）
      if (stats.pendingCount > peakPendingCount) {
        peakPendingCount = stats.pendingCount;
      }

      // 進捗を計算（処理済み / ピーク値）
      const processed = peakPendingCount - stats.pendingCount;
      const progress = peakPendingCount > 0 ? processed / peakPendingCount : 0;

      // stroke-dashoffsetを設定（0 = 100%, circumference = 0%）
      const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - progress);
      progressBar.style.strokeDashoffset = String(offset);

      // ツールチップを更新
      proofStatusItemEl?.setAttribute('title', `Processing: ${stats.pendingCount} remaining (${processed}/${peakPendingCount} done)`);
    } else {
      // 待機中: プログレスリングを非表示、ピークをリセット
      proofProgressRing.classList.remove('processing');
      peakPendingCount = 0;
      progressBar.style.strokeDashoffset = String(PROGRESS_RING_CIRCUMFERENCE);
      proofStatusItemEl?.setAttribute('title', 'Typing proof status');
    }
  }

  // 100イベントごとにスナップショット記録
  if (stats.totalEvents > 0 && stats.totalEvents % 100 === 0) {
    const editorContent = editor.getValue();
    activeProof.recordContentSnapshot(editorContent)
      .then(result => {
        console.log('[TypedCode] Content snapshot recorded at event', result.index);
      })
      .catch(error => {
        console.error('[TypedCode] Snapshot recording failed:', error);
      });
  }
}

// 処理待機ダイアログ関連
const processingDialog = document.getElementById('processing-dialog');
const processingProgressBar = document.getElementById('processing-progress-bar');
const processingStatus = document.getElementById('processing-status');
const processingCancelBtn = document.getElementById('processing-cancel-btn');
let processingCancelled = false;

/**
 * ハッシュチェーン生成が完了するまで待機
 * @returns true: 完了, false: キャンセルされた
 */
async function waitForProcessingComplete(): Promise<boolean> {
  const activeProof = tabManager?.getActiveProof();
  if (!activeProof) return true;

  const stats = activeProof.getStats();
  if (stats.pendingCount === 0) {
    return true;  // 待機不要
  }

  // ダイアログを表示
  processingCancelled = false;
  processingDialog?.classList.remove('hidden');

  const initialPending = stats.pendingCount;

  return new Promise<boolean>((resolve) => {
    const checkInterval = setInterval(() => {
      const currentStats = activeProof.getStats();

      if (processingCancelled) {
        clearInterval(checkInterval);
        processingDialog?.classList.add('hidden');
        resolve(false);
        return;
      }

      if (currentStats.pendingCount === 0) {
        clearInterval(checkInterval);
        processingDialog?.classList.add('hidden');
        resolve(true);
        return;
      }

      // プログレスバーを更新
      const processed = initialPending - currentStats.pendingCount;
      const progress = initialPending > 0 ? (processed / initialPending) * 100 : 0;
      if (processingProgressBar) {
        processingProgressBar.style.width = `${progress}%`;
      }
      if (processingStatus) {
        processingStatus.textContent = `処理中: ${currentStats.pendingCount} 件待機中 (${processed}/${initialPending} 完了)`;
      }
    }, 100);
  });
}

// 処理待機ダイアログのキャンセルボタン
processingCancelBtn?.addEventListener('click', () => {
  processingCancelled = true;
});

/**
 * エクスポート前にTurnstile検証を実行し、attestationを記録
 */
async function performPreExportVerification(activeTab: TabState): Promise<boolean> {
  if (!isTurnstileConfigured()) {
    return true; // 開発環境ではスキップ
  }

  showNotification('エクスポート前の認証を実行中...');

  const result = await performTurnstileVerification('export_proof');

  if (!result.success || !result.attestation) {
    console.error('[Export] Pre-export verification failed:', result.error);
    showNotification('エクスポート前の認証に失敗しました');
    return false;
  }

  // アクティブタブのTypingProofにエクスポート前attestationを記録
  await activeTab.typingProof.recordPreExportAttestation({
    verified: result.attestation.verified,
    score: result.attestation.score,
    action: result.attestation.action,
    timestamp: result.attestation.timestamp,
    hostname: result.attestation.hostname,
    signature: result.attestation.signature,
  });
  console.log('[Export] Pre-export attestation recorded');

  return true;
}

// 証明データのエクスポート機能（アクティブタブのみ）
const exportProofBtn = document.getElementById('export-proof-btn');
exportProofBtn?.addEventListener('click', async () => {
  try {
    const activeTab = tabManager?.getActiveTab();
    if (!activeTab) return;

    // ハッシュチェーン生成完了を待機
    const completed = await waitForProcessingComplete();
    if (!completed) {
      showNotification('エクスポートがキャンセルされました');
      return;
    }

    // エクスポート前にTurnstile検証を実行
    const verified = await performPreExportVerification(activeTab);
    if (!verified) {
      return;
    }

    const proofData = await tabManager!.exportSingleTab(activeTab.id);
    if (!proofData) return;

    const exportData = {
      ...proofData,
      content: activeTab.model.getValue(),
      language: activeTab.language,
    };

    const jsonString = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const timestamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const tabFilename = activeTab.filename.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `TC_${tabFilename}_${timestamp}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    console.log('[TypedCode] Proof exported successfully');
    console.log('Total events:', proofData.proof.totalEvents);
    console.log('Final hash:', proofData.proof.finalHash);
    console.log('Signature:', proofData.proof.signature);

    const verification = await activeTab.typingProof.verify();
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

/**
 * 全タブに対してエクスポート前のTurnstile検証を実行
 */
async function performPreExportVerificationForAllTabs(): Promise<boolean> {
  if (!isTurnstileConfigured() || !tabManager) {
    return true;
  }

  showNotification('エクスポート前の認証を実行中...');

  const result = await performTurnstileVerification('export_proof');

  if (!result.success || !result.attestation) {
    console.error('[Export] Pre-export verification failed:', result.error);
    showNotification('エクスポート前の認証に失敗しました');
    return false;
  }

  // 全タブのTypingProofにエクスポート前attestationを記録
  const allTabs = tabManager.getAllTabs();
  for (const tab of allTabs) {
    await tab.typingProof.recordPreExportAttestation({
      verified: result.attestation.verified,
      score: result.attestation.score,
      action: result.attestation.action,
      timestamp: result.attestation.timestamp,
      hostname: result.attestation.hostname,
      signature: result.attestation.signature,
    });
  }
  console.log(`[Export] Pre-export attestation recorded for ${allTabs.length} tabs`);

  return true;
}

// ZIPでまとめてダウンロード（全タブをマルチファイル形式でエクスポート）
const exportZipBtn = document.getElementById('export-zip-btn');
exportZipBtn?.addEventListener('click', async () => {
  try {
    if (!tabManager) return;

    // ハッシュチェーン生成完了を待機
    const completed = await waitForProcessingComplete();
    if (!completed) {
      showNotification('エクスポートがキャンセルされました');
      return;
    }

    // エクスポート前にTurnstile検証を実行（全タブに適用）
    const verified = await performPreExportVerificationForAllTabs();
    if (!verified) {
      return;
    }

    const multiProofData = await tabManager.exportAllTabs();

    // ZIPファイルを作成
    const zip = new JSZip();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // 各ファイルを追加
    for (const [filename, fileData] of Object.entries(multiProofData.files)) {
      zip.file(filename, fileData.content);
    }

    // マルチファイル証明ファイルを追加
    const jsonString = JSON.stringify(multiProofData, null, 2);
    zip.file(`typedcode-multi-proof-${timestamp}.json`, jsonString);

    // READMEを追加
    const fileList = Object.keys(multiProofData.files).map(f => `- ${f}`).join('\n');
    const readme = `TypedCode Multi-File Export
===========================

This archive contains:
${fileList}
- typedcode-multi-proof-${timestamp}.json: Multi-file typing proof data

To verify this proof:
1. Visit the TypedCode verification page
2. Drop the proof JSON file to verify

Generated: ${new Date().toISOString()}
Total files: ${multiProofData.metadata.totalFiles}
Pure typing: ${multiProofData.metadata.overallPureTyping ? 'Yes' : 'No'}
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

    showNotification(`ZIPファイルをダウンロードしました（${multiProofData.metadata.totalFiles}ファイル）`);
  } catch (error) {
    console.error('[TypedCode] ZIP export failed:', error);
    showNotification('ZIPエクスポートに失敗しました');
  }
});

// 初期化オーバーレイの制御
const initOverlay = document.getElementById('init-overlay');
const initMessage = initOverlay?.querySelector('.init-message');

function updateInitMessage(message: string): void {
  if (initMessage) {
    initMessage.textContent = message;
  }
}

function hideInitOverlay(): void {
  if (initOverlay) {
    initOverlay.classList.add('hidden');
    // アニメーション完了後にDOMから削除
    setTimeout(() => {
      initOverlay.remove();
    }, 300);
  }
}

// 初期化処理
async function initializeApp(): Promise<void> {
  console.log('[TypedCode] Initializing app...');

  // 利用規約モーダルを先に表示（未同意の場合）
  if (!hasAcceptedTerms()) {
    // 利用規約モーダルを表示するためオーバーレイを一時的に非表示
    initOverlay?.classList.add('hidden');
    console.log('[TypedCode] Showing terms modal...');
    await showTermsModal();
    // 同意後、オーバーレイを再表示
    initOverlay?.classList.remove('hidden');
    updateInitMessage('初期化中...');
  }

  // C言語実行環境をバックグラウンドで初期化（awaitしない）
  // エディタ操作をブロックせず、並行してダウンロードを進める
  initializeCRuntimeInBackground().catch(err => {
    console.warn('[TypedCode] Background C runtime initialization failed:', err);
  });

  // Turnstileスクリプトをプリロード（設定されている場合のみ）
  if (isTurnstileConfigured()) {
    preloadTurnstile().catch(err => {
      console.warn('[TypedCode] Turnstile preload failed:', err);
    });
  }

  updateInitMessage('デバイス情報を取得中...');
  console.log('[TypedCode] Getting device ID...');
  const deviceId = await Fingerprint.getDeviceId();
  console.log('[TypedCode] Device ID:', deviceId.substring(0, 16) + '...');

  const fingerprintComponents = await Fingerprint.collectComponents();
  const fingerprintHash = await Fingerprint.generate();

  // TabManagerを初期化
  tabManager = new TabManager(editor);

  // タブ変更コールバックを設定
  tabManager.setOnTabChange((tab, previousTab) => {
    console.log('[TypedCode] Tab switched:', previousTab?.filename, '->', tab.filename);
    updateTabUI();
    updateProofStatus();

    // ブラウザタブのタイトルを更新
    document.title = `${tab.filename} - TypedCode`;

    // 言語セレクタを更新
    if (languageSelector) {
      languageSelector.value = tab.language;
    }

    // タブ切り替え時にターミナルの言語説明を更新
    showLanguageDescriptionInTerminal(tab.language);
    // ランタイムインジケーターを更新
    updateLanguageRuntimeIndicator(tab.language);

    // LogViewerの表示を更新
    if (logViewer) {
      logViewer.setTypingProof(tab.typingProof);
    }
  });

  tabManager.setOnTabUpdate(() => {
    updateTabUI();
    // アクティブタブの場合、ブラウザタイトルも更新
    const activeTab = tabManager?.getActiveTab();
    if (activeTab) {
      document.title = `${activeTab.filename} - TypedCode`;
    }
  });

  // 認証結果でタブUIを更新
  tabManager.setOnVerification(() => {
    updateTabUI();
  });

  isEventRecordingEnabled = false;

  updateInitMessage('エディタを初期化中...');

  const initialized = await tabManager.initialize(deviceId, {
    deviceId,
    fingerprintHash,
    ...fingerprintComponents
  } as Parameters<typeof tabManager.initialize>[1]);

  if (!initialized) {
    // Turnstile失敗時（初期化に失敗した場合）
    updateInitMessage('認証に失敗しました。ページをリロードしてください。');
    showNotification('認証に失敗しました。ページをリロードしてください。');
    console.error('[TypedCode] Initialization failed (Turnstile)');
    return;
  }

  // 初期化完了 - オーバーレイを非表示
  hideInitOverlay();

  // タブUIを生成
  updateTabUI();

  console.log('[TypedCode] TabManager initialized');

  // 言語セレクタを更新
  const activeTab = tabManager.getActiveTab();
  if (activeTab && languageSelector) {
    languageSelector.value = activeTab.language;
  }

  updateProofStatus();

  isEventRecordingEnabled = true;
  console.log('[TypedCode] Event recording enabled');

  // 利用規約同意をハッシュチェーンに記録（初回のみ）
  const activeProofForTerms = tabManager.getActiveProof();
  if (activeProofForTerms) {
    const termsData = localStorage.getItem(TERMS_ACCEPTED_KEY);
    if (termsData) {
      try {
        const parsed = JSON.parse(termsData);
        // 新規タブで、まだtermsAcceptedイベントが記録されていない場合のみ記録
        const hasTermsEvent = activeProofForTerms.events.some(e => e.type === 'termsAccepted');
        if (!hasTermsEvent) {
          activeProofForTerms.recordEvent({
            type: 'termsAccepted',
            data: {
              version: parsed.version,
              timestamp: parsed.timestamp,
              agreedAt: parsed.agreedAt
            },
            description: `Terms v${parsed.version} accepted`
          }).then(() => {
            console.log('[TypedCode] Terms acceptance recorded to hash chain');
            tabManager?.saveToStorage();
          }).catch(err => {
            console.error('[TypedCode] Failed to record terms acceptance:', err);
          });
        }
      } catch (err) {
        console.error('[TypedCode] Failed to parse terms data:', err);
      }
    }
  }

  // 初期ウィンドウサイズを記録
  recordWindowResize(true);

  // ウィンドウリサイズイベントのリスナー（デバウンス付き）
  window.addEventListener('resize', () => {
    if (windowResizeTimeout) {
      clearTimeout(windowResizeTimeout);
    }
    windowResizeTimeout = setTimeout(() => {
      recordWindowResize(false);
    }, WINDOW_RESIZE_DEBOUNCE_MS);
  });

  const logEntriesContainer = document.getElementById('log-entries');
  if (!logEntriesContainer) {
    console.error('[TypedCode] log-entries not found!');
    return;
  }

  const initialProof = tabManager.getActiveProof();
  if (initialProof) {
    logViewer = new LogViewer(logEntriesContainer, initialProof);
    console.log('[TypedCode] LogViewer initialized');
  }

  // 設定ドロップダウンメニュー
  const settingsBtn = document.getElementById('settings-btn');
  const settingsDropdown = document.getElementById('settings-dropdown');

  if (settingsBtn && settingsDropdown) {
    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsDropdown.classList.toggle('visible');
    });

    // 外側クリックでドロップダウンを閉じる
    document.addEventListener('click', (e) => {
      if (!settingsDropdown.contains(e.target as Node) && !settingsBtn.contains(e.target as Node)) {
        settingsDropdown.classList.remove('visible');
      }
    });
  }

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
      // ドロップダウンを閉じる
      settingsDropdown?.classList.remove('visible');
    });

    updateThemeIcon();
  }

  // ターミナルパネルのトグル
  const toggleTerminalBtn = document.getElementById('toggle-terminal-btn');
  const terminalPanel = document.getElementById('terminal-panel');
  const closeTerminalBtn = document.getElementById('close-terminal-btn');

  const updateTerminalButtonState = (): void => {
    if (terminalPanel?.classList.contains('visible')) {
      toggleTerminalBtn?.classList.add('active');
    } else {
      toggleTerminalBtn?.classList.remove('active');
    }
  };

  if (toggleTerminalBtn && terminalPanel) {
    toggleTerminalBtn.addEventListener('click', () => {
      const isVisible = terminalPanel.classList.contains('visible');
      if (isVisible) {
        terminalPanel.classList.remove('visible');
      } else {
        terminalPanel.classList.add('visible');
      }
      updateTerminalButtonState();
      // ターミナルのサイズを調整
      cTerminal?.fit();
    });
  }

  if (closeTerminalBtn && terminalPanel) {
    closeTerminalBtn.addEventListener('click', () => {
      terminalPanel.classList.remove('visible');
      updateTerminalButtonState();
    });
  }

  // xterm.js ターミナルの初期化
  const xtermContainer = document.getElementById('xterm-container');
  if (xtermContainer) {
    cTerminal = new CTerminal(xtermContainer);

    // 初期タブの言語に応じた説明を表示
    const initialTab = tabManager?.getActiveTab();
    const initialLanguage = initialTab?.language ?? 'c';
    showLanguageDescriptionInTerminal(initialLanguage);
    // ランタイムインジケーターを初期化
    updateLanguageRuntimeIndicator(initialLanguage);

    // ターミナル入力をハッシュチェーンに記録
    cTerminal.setInputCallback((input: string) => {
      recordEventAsync({
        type: 'terminalInput',
        description: `ターミナル入力: ${input}`,
      });
    });
  }

  // Run/Stopボタンのハンドラ
  const runCodeBtn = document.getElementById('run-code-btn');
  const stopCodeBtn = document.getElementById('stop-code-btn');
  const clangLoadingOverlay = document.getElementById('clang-loading-overlay');
  const clangStatus = document.getElementById('clang-status');

  const showClangLoading = (): void => {
    clangLoadingOverlay?.classList.remove('hidden');
  };

  const hideClangLoading = (): void => {
    clangLoadingOverlay?.classList.add('hidden');
  };

  const updateClangStatus = (message: string): void => {
    if (clangStatus) {
      clangStatus.textContent = message;
    }
  };

  const showErrorsInEditor = (errors: ParsedError[]): void => {
    const activeTab = tabManager?.getActiveTab();
    if (!activeTab) return;

    const markers = errors.map(err => ({
      startLineNumber: err.line,
      startColumn: err.column,
      endLineNumber: err.line,
      endColumn: activeTab.model.getLineMaxColumn(err.line),
      message: err.message,
      severity: err.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : err.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
    }));

    monaco.editor.setModelMarkers(activeTab.model, 'c-compiler', markers);
  };

  const clearEditorErrors = (): void => {
    const activeTab = tabManager?.getActiveTab();
    if (activeTab) {
      monaco.editor.setModelMarkers(activeTab.model, 'c-compiler', []);
    }
  };

  // 実行対応言語のリスト
  const EXECUTABLE_LANGUAGES = ['c', 'cpp', 'javascript', 'typescript', 'python'];

  // 言語に対応するExecutorを取得
  const getExecutorForLanguage = (language: string): ILanguageExecutor | null => {
    switch (language) {
      case 'c':
        return getCExecutor();
      case 'cpp':
        return getCppExecutor();
      case 'javascript':
        return getJavaScriptExecutor();
      case 'typescript':
        return getTypeScriptExecutor();
      case 'python':
        return getPythonExecutor();
      default:
        return null;
    }
  };

  // 現在実行中のExecutor
  let currentExecutor: ILanguageExecutor | null = null;

  const handleRunCode = async (): Promise<void> => {
    if (isRunningCode) {
      showNotification('既にコードを実行中です');
      return;
    }

    const activeTab = tabManager?.getActiveTab();
    if (!activeTab) {
      showNotification('アクティブなタブがありません');
      return;
    }

    // 実行対応言語かチェック
    if (!EXECUTABLE_LANGUAGES.includes(activeTab.language)) {
      showNotification(`${activeTab.language} は実行できません`);
      return;
    }

    // 言語に対応するExecutorを取得
    const executor = getExecutorForLanguage(activeTab.language);
    if (!executor) {
      showNotification(`${activeTab.language} の実行環境が見つかりません`);
      return;
    }
    currentExecutor = executor;

    isRunningCode = true;
    runCodeBtn?.classList.add('running');
    stopCodeBtn?.classList.remove('hidden');
    clearEditorErrors();

    // ターミナル表示
    if (terminalPanel) {
      terminalPanel.classList.add('visible');
      updateTerminalButtonState();
    }

    cTerminal?.clear();

    // 言語に応じたメッセージ
    const isCompiled = activeTab.language === 'c' || activeTab.language === 'cpp';
    const langName = executor.config.name; // 'C', 'C++', 'JavaScript'
    if (isCompiled) {
      cTerminal?.writeInfo(`$ Compiling ${langName} program (${activeTab.filename})...\n`);
    } else {
      cTerminal?.writeInfo(`$ Running ${langName} (${activeTab.filename})...\n`);
    }

    // コード実行イベントをハッシュチェーンに記録
    recordEventAsync({
      type: 'codeExecution',
      description: `コード実行: ${activeTab.filename}`,
    });

    try {
      // 初回は初期化（C/C++の場合はコンパイラをダウンロード）
      if (!executor.isInitialized) {
        if (isCompiled) {
          showClangLoading();
        }
        updateRuntimeStatus(activeTab.language, 'loading');
        await executor.initialize((progress) => {
          if (isCompiled) {
            updateClangStatus(progress.message);
          }
          cTerminal?.writeInfo(progress.message + '\n');
        });
        updateRuntimeStatus(activeTab.language, 'ready');
        if (isCompiled) {
          hideClangLoading();
        }
      }

      const code = activeTab.model.getValue();

      const result = await executor.run(code, {
        onStdout: (text: string) => cTerminal?.write(text),
        onStderr: (text: string) => {
          cTerminal?.writeError(text);
          // エラーをパースしてエディタに表示
          const errors = executor.parseErrors(text) ?? [];
          if (errors.length > 0) {
            showErrorsInEditor(errors);
          }
        },
        onStdinReady: (stdinStream: WritableStream<Uint8Array>) => {
          cTerminal?.connectStdin(stdinStream);
        },
        onProgress: (msg: string) => cTerminal?.writeInfo(msg + '\n'),
      });

      if (result) {
        if (result.success) {
          cTerminal?.writeSuccess(`\n$ ${langName} exited with code ${result.exitCode}\n`);
        } else {
          cTerminal?.writeError(`\n$ ${langName} failed with code ${result.exitCode}\n`);
        }
      }
    } catch (error) {
      console.error('[TypedCode] Execution error:', error);
      hideClangLoading();
      cTerminal?.writeError('Execution error: ' + error + '\n');
      showNotification('コードの実行に失敗しました');
    } finally {
      isRunningCode = false;
      currentExecutor = null;
      cTerminal?.disconnectStdin(); // Disconnect stdin stream
      runCodeBtn?.classList.remove('running');
      stopCodeBtn?.classList.add('hidden');
    }
  };

  const handleStopCode = (): void => {
    if (currentExecutor && isRunningCode) {
      const langName = currentExecutor.config.name;
      currentExecutor.abort();
      cTerminal?.disconnectStdin(); // Disconnect stdin stream
      cTerminal?.writeError(`\n$ ${langName} execution aborted\n`);
      isRunningCode = false;
      runCodeBtn?.classList.remove('running');
      stopCodeBtn?.classList.add('hidden');
    }
  };

  runCodeBtn?.addEventListener('click', () => void handleRunCode());
  stopCodeBtn?.addEventListener('click', handleStopCode);

  // Ctrl+Enter でコード実行
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      void handleRunCode();
    }
  });

  // ターミナルパネルのリサイズ機能
  const terminalResizeHandle = document.getElementById('terminal-resize-handle');
  const workbenchUpperEl = document.querySelector('.workbench-upper') as HTMLElement | null;

  if (terminalResizeHandle && terminalPanel && workbenchUpperEl) {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    terminalResizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      isResizing = true;
      startY = e.clientY;
      startHeight = terminalPanel.offsetHeight;

      terminalPanel.classList.add('resizing');
      workbenchUpperEl.classList.add('resizing');
      terminalResizeHandle.classList.add('dragging');

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!isResizing) return;

      const workbenchEl = document.querySelector('.workbench') as HTMLElement | null;
      if (!workbenchEl) return;

      const workbenchHeight = workbenchEl.clientHeight;
      const deltaY = startY - e.clientY;
      const newHeight = startHeight + deltaY;

      // 最小高さ100px、最大高さは画面の60%
      const minHeight = 100;
      const maxHeight = workbenchHeight * 0.6;
      const clampedHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));

      terminalPanel.style.height = `${clampedHeight}px`;

      // xterm.jsのリサイズ
      cTerminal?.fit();
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;

      isResizing = false;

      terminalPanel.classList.remove('resizing');
      workbenchUpperEl.classList.remove('resizing');
      terminalResizeHandle.classList.remove('dragging');

      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  const toggleLogBtn = document.getElementById('toggle-log-btn');
  const updateLogToggleButtonState = (): void => {
    if (logViewer?.isVisible) {
      toggleLogBtn?.classList.add('active');
    } else {
      toggleLogBtn?.classList.remove('active');
    }
  };

  if (toggleLogBtn) {
    toggleLogBtn.addEventListener('click', () => {
      console.log('[TypedCode] Toggle log button clicked');
      logViewer?.toggle();
      updateLogToggleButtonState();
    });
    console.log('[TypedCode] Toggle button listener added');
  } else {
    console.error('[TypedCode] toggle-log-btn not found!');
  }

  const closeLogBtn = document.getElementById('close-log-btn');
  if (closeLogBtn) {
    closeLogBtn.addEventListener('click', () => {
      logViewer?.hide();
      updateLogToggleButtonState();
    });
  }

  // ステータスバーのイベント情報クリックでログビューを表示
  const eventCountItem = document.querySelector('.status-item[title="Total events recorded"]');
  if (eventCountItem) {
    (eventCountItem as HTMLElement).style.cursor = 'pointer';
    eventCountItem.addEventListener('click', () => {
      if (!logViewer?.isVisible) {
        logViewer?.show();
        updateLogToggleButtonState();
      }
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

  // アプリ初期化完了フラグを設定
  isAppInitialized = true;
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
