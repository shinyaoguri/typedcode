console.log('[DEBUG] ===== main.ts TOP LEVEL LOADING =====');

import * as monaco from 'monaco-editor';
import './styles/main.css';
import { Fingerprint } from '@typedcode/shared';
import type {
  CursorPosition,
  RecordEventInput,
  DetectedEvent,
} from '@typedcode/shared';
import { InputDetector } from './tracking/InputDetector.js';
import { OperationDetector } from './tracking/OperationDetector.js';
import { KeystrokeTracker } from './tracking/KeystrokeTracker.js';
import { MouseTracker } from './tracking/MouseTracker.js';
import { LogViewer } from './ui/components/LogViewer.js';
import { ThemeManager } from './editor/ThemeManager.js';
import { TabManager } from './ui/tabs/TabManager.js';
import type { MonacoEditor } from './editor/types.js';
import {
  isTurnstileConfigured,
  loadTurnstileScript as preloadTurnstile,
} from './services/TurnstileService.js';
import { CTerminal } from './terminal/CTerminal.js';
import type { ParsedError } from './executors/c/CExecutor.js';
import '@xterm/xterm/css/xterm.css';

// 新しいモジュールのインポート
import { configureMonacoWorkers } from './app/MonacoConfig.js';
import { WindowTracker } from './tracking/WindowTracker.js';
import { VisibilityTracker } from './tracking/VisibilityTracker.js';
import { ProcessingDialog } from './ui/components/ProcessingDialog.js';
import { ProofStatusDisplay } from './ui/components/ProofStatusDisplay.js';
import { CursorTracker } from './editor/CursorTracker.js';
import { EditorController } from './editor/EditorController.js';
import { SettingsDropdown } from './ui/components/SettingsDropdown.js';
import { TerminalPanel } from './ui/panels/TerminalPanel.js';
import { CodeExecutionController } from './execution/CodeExecutionController.js';
import { ProofExporter } from './export/ProofExporter.js';
import { RuntimeManager } from './core/RuntimeManager.js';
import { TabUIController } from './ui/tabs/TabUIController.js';
import { LogViewerPanel } from './ui/panels/LogViewerPanel.js';
import { EventRecorder } from './core/EventRecorder.js';

// Monaco Editor の Worker 設定
configureMonacoWorkers();

// 操作検出器の初期化
const operationDetector = new OperationDetector();

// TabManager（initializeApp後に初期化）
let tabManager: TabManager | null = null;

// ログビューアの初期化（DOMContentLoaded後に行う）
let logViewer: LogViewer | null = null;

// 新しいトラッカーのインスタンス
const windowTracker = new WindowTracker();
const visibilityTracker = new VisibilityTracker();
const keystrokeTracker = new KeystrokeTracker();
const mouseTracker = new MouseTracker({ throttleMs: 100 });

// ProcessingDialogとProofStatusDisplayのインスタンス
const processingDialog = new ProcessingDialog();
const proofStatusDisplay = new ProofStatusDisplay();

// CursorTrackerとEditorControllerのインスタンス
const cursorTracker = new CursorTracker({
  onCursorPositionUpdate: (lineNumber, column) => {
    const lineEl = document.getElementById('cursor-line');
    const colEl = document.getElementById('cursor-col');
    if (lineEl) lineEl.textContent = String(lineNumber);
    if (colEl) colEl.textContent = String(column);
  },
});
const editorController = new EditorController({
  operationDetector,
  debug: import.meta.env.DEV,
});

// SettingsDropdownとTerminalPanelのインスタンス
const settingsDropdown = new SettingsDropdown();
const terminalPanelController = new TerminalPanel();

// CodeExecutionControllerのインスタンス
const codeExecutionController = new CodeExecutionController();

// ProofExporterのインスタンス
const proofExporter = new ProofExporter();

// RuntimeManagerのインスタンス
const runtimeManager = new RuntimeManager();

// ページ離脱確認を無効化するフラグ（リセット時に使用）
let skipBeforeUnload = false;

// ターミナル・実行環境
let cTerminal: CTerminal | null = null;

// EventRecorder（initializeApp後に初期化）
let eventRecorder: EventRecorder | null = null;

// 利用規約関連
const TERMS_ACCEPTED_KEY = 'typedcode-terms-accepted';
const TERMS_VERSION = '1.0';  // バージョン管理（規約変更時に再同意を求める）

/**
 * ターミナルに言語説明を表示
 */
function showLanguageDescriptionInTerminal(language: string): void {
  if (!cTerminal) return;
  cTerminal.clear();
  const langDesc = runtimeManager.getLanguageDescription(language);
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

// UI要素の取得
const blockNotificationEl = document.getElementById('block-notification');
const blockMessageEl = document.getElementById('block-message');

// タブ要素
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

// TabUIControllerのインスタンス（initializeApp内で初期化）
let tabUIController: TabUIController | null = null;

// 言語切り替え
const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
if (languageSelector) {
  languageSelector.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    const activeTab = tabManager?.getActiveTab();
    if (activeTab) {
      tabManager?.setTabLanguage(activeTab.id, target.value);
      tabUIController?.updateUI();
      // 言語切り替え時にターミナルに説明を表示
      showLanguageDescriptionInTerminal(target.value);
      // ランタイムインジケーターを更新
      runtimeManager.updateIndicator(target.value);
    }
  });
}

// 新規タブ追加ボタン
addTabBtn?.addEventListener('click', async () => {
  if (!tabManager) return;

  // Turnstile設定時は認証中メッセージを表示
  if (isTurnstileConfigured()) {
    showNotification('人間認証を実行中...');
  }

  const num = tabUIController?.getNextUntitledNumber() ?? 1;
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

      eventRecorder?.record(event);
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
  const extension = tabUIController?.getFileExtension(activeTab.language) ?? 'txt';
  const filename = `${activeTab.filename}.${extension}`;

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

// Note: Editor content/cursor/selection events are now handled by EditorController/CursorTracker (initialized in initializeApp)
// Note: Mouse/Keystroke events are now handled by MouseTracker/KeystrokeTracker (initialized in initializeApp)

// 証明ステータスを更新
function updateProofStatus(): void {
  proofStatusDisplay.update();
}

// 証明データのエクスポート機能（ProofExporterを使用）
const exportProofBtn = document.getElementById('export-proof-btn');
exportProofBtn?.addEventListener('click', () => void proofExporter.exportSingleTab());

// ZIPでまとめてダウンロード（全タブをマルチファイル形式でエクスポート）
const exportZipBtn = document.getElementById('export-zip-btn');
exportZipBtn?.addEventListener('click', () => void proofExporter.exportAllTabsAsZip());

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
  console.log('[DEBUG INIT] ===== initializeApp START =====');

  // 利用規約モーダルを先に表示（未同意の場合）
  console.log('[DEBUG INIT] hasAcceptedTerms:', hasAcceptedTerms());
  if (!hasAcceptedTerms()) {
    // 利用規約モーダルを表示するためオーバーレイを一時的に非表示
    initOverlay?.classList.add('hidden');
    console.log('[TypedCode] Showing terms modal...');
    await showTermsModal();
    // 同意後、オーバーレイを再表示
    initOverlay?.classList.remove('hidden');
    updateInitMessage('初期化中...');
    console.log('[DEBUG INIT] Terms accepted, continuing...');
  }

  console.log('[DEBUG INIT] Starting background C runtime init...');
  // C言語実行環境をバックグラウンドで初期化（awaitしない）
  // エディタ操作をブロックせず、並行してダウンロードを進める
  runtimeManager.initializeCRuntime().catch((err: unknown) => {
    console.warn('[TypedCode] Background C runtime initialization failed:', err);
  });

  // Turnstileスクリプトをプリロード（設定されている場合のみ）
  if (isTurnstileConfigured()) {
    preloadTurnstile().catch(err => {
      console.warn('[TypedCode] Turnstile preload failed:', err);
    });
  }

  console.log('[DEBUG INIT] Getting device ID...');
  updateInitMessage('デバイス情報を取得中...');
  const deviceId = await Fingerprint.getDeviceId();
  console.log('[DEBUG INIT] Device ID:', deviceId.substring(0, 16) + '...');

  console.log('[DEBUG INIT] Collecting fingerprint...');
  const fingerprintComponents = await Fingerprint.collectComponents();
  const fingerprintHash = await Fingerprint.generate();
  console.log('[DEBUG INIT] Fingerprint collected');

  // TabManagerを初期化
  console.log('[DEBUG INIT] Creating TabManager...');
  tabManager = new TabManager(editor);

  // TabUIControllerを初期化
  const editorTabsContainer = document.getElementById('editor-tabs');
  if (editorTabsContainer) {
    tabUIController = new TabUIController({
      container: editorTabsContainer,
      tabManager,
      basePath: import.meta.env.BASE_URL,
      onNotification: showNotification,
    });
  }

  // ProofExporterの初期化
  proofExporter.setTabManager(tabManager);
  proofExporter.setProcessingDialog(processingDialog);
  proofExporter.setCallbacks({
    onNotification: showNotification,
  });

  // ProofStatusDisplayのコールバックを設定
  proofStatusDisplay.setGetStats(() => {
    const activeProof = tabManager?.getActiveProof();
    if (!activeProof) return null;
    return activeProof.getStats();
  });

  proofStatusDisplay.setSnapshotCallback(
    (content) => {
      const activeProof = tabManager?.getActiveProof();
      if (!activeProof) return Promise.reject(new Error('No active proof'));
      return activeProof.recordContentSnapshot(content);
    },
    () => editor.getValue()
  );

  // タブ変更コールバックを設定
  tabManager.setOnTabChange((tab, previousTab) => {
    console.log('[TypedCode] Tab switched:', previousTab?.filename, '->', tab.filename);
    tabUIController?.updateUI();
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
    runtimeManager.updateIndicator(tab.language);

    // LogViewerの表示を更新
    if (logViewer) {
      logViewer.setTypingProof(tab.typingProof);
    }
  });

  tabManager.setOnTabUpdate(() => {
    tabUIController?.updateUI();
    // アクティブタブの場合、ブラウザタイトルも更新
    const activeTab = tabManager?.getActiveTab();
    if (activeTab) {
      document.title = `${activeTab.filename} - TypedCode`;
    }
  });

  // 認証結果でタブUIを更新
  tabManager.setOnVerification(() => {
    tabUIController?.updateUI();
  });

  updateInitMessage('エディタを初期化中...');
  console.log('[DEBUG] Before tabManager.initialize()');

  const initialized = await tabManager.initialize(fingerprintHash, fingerprintComponents);
  console.log('[DEBUG] After tabManager.initialize(), result:', initialized);

  if (!initialized) {
    // Turnstile失敗時（初期化に失敗した場合）
    updateInitMessage('認証に失敗しました。ページをリロードしてください。');
    showNotification('認証に失敗しました。ページをリロードしてください。');
    console.error('[TypedCode] Initialization failed (Turnstile)');
    return;
  }

  console.log('[DEBUG] Calling hideInitOverlay()');
  // 初期化完了 - オーバーレイを非表示
  hideInitOverlay();

  console.log('[DEBUG] Calling tabUIController.updateUI()');
  // タブUIを生成
  tabUIController?.updateUI();

  console.log('[DEBUG] TabManager initialized, activeTab:', tabManager.getActiveTab());
  console.log('[TypedCode] TabManager initialized');

  // 言語セレクタを更新
  const activeTab = tabManager.getActiveTab();
  if (activeTab && languageSelector) {
    languageSelector.value = activeTab.language;
  }

  updateProofStatus();

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

  // WindowTrackerの初期化とコールバック設定
  windowTracker.setCallback((event) => {
    eventRecorder?.record({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  windowTracker.attach();
  windowTracker.recordInitial();

  // VisibilityTrackerの初期化とコールバック設定
  visibilityTracker.setCallback((event) => {
    eventRecorder?.record({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  visibilityTracker.attach();

  // KeystrokeTrackerの初期化とコールバック設定
  keystrokeTracker.setCallback((event) => {
    eventRecorder?.record({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  keystrokeTracker.attach(editorContainer!);

  // MouseTrackerの初期化とコールバック設定
  mouseTracker.setCallback((event) => {
    eventRecorder?.record({
      type: event.type,
      data: event.data,
      description: event.description,
    });
  });
  mouseTracker.attach(editorContainer!);

  // CursorTrackerの初期化とコールバック設定
  cursorTracker.setCallback((event) => {
    if (event.type === 'cursorPositionChange') {
      eventRecorder?.record({
        type: event.type,
        data: event.data,
      });
    } else {
      eventRecorder?.record({
        type: event.type,
        data: event.data,
        range: event.range,
        rangeLength: event.rangeLength,
        selectedText: event.selectedText,
        description: event.description,
      });
    }
  });
  cursorTracker.attach(editor);

  // EditorControllerの初期化とコールバック設定
  editorController.setContentChangeCallback((event) => {
    eventRecorder?.record({
      type: event.type,
      inputType: event.inputType,
      data: event.data,
      rangeOffset: event.rangeOffset,
      rangeLength: event.rangeLength,
      range: event.range,
      isMultiLine: event.isMultiLine,
      description: event.description,
      ...(event.deletedLength && { deletedLength: event.deletedLength }),
      ...(event.insertedText && { insertedText: event.insertedText }),
      ...(event.insertLength && { insertLength: event.insertLength }),
      ...(event.deleteDirection && { deleteDirection: event.deleteDirection }),
    });
  });
  editorController.setAfterChangeCallback(() => {
    updateProofStatus();
    tabManager?.saveToStorage();
  });
  editorController.attach(editor);

  const logEntriesContainer = document.getElementById('log-entries');
  if (!logEntriesContainer) {
    console.error('[TypedCode] log-entries not found!');
    return;
  }

  const initialProof = tabManager.getActiveProof();
  console.log('[DEBUG] initialProof:', initialProof);
  if (initialProof) {
    logViewer = new LogViewer(logEntriesContainer, initialProof);
    console.log('[TypedCode] LogViewer initialized');
  } else {
    console.warn('[DEBUG] No initialProof - LogViewer NOT initialized');
  }

  // EventRecorderの初期化
  console.log('[DEBUG] Creating EventRecorder...');
  eventRecorder = new EventRecorder({
    tabManager,
    logViewer,
    onStatusUpdate: () => updateProofStatus(),
    onError: (msg) => showNotification(msg),
  });
  eventRecorder.setInitialized(true);
  console.log('[DEBUG] EventRecorder initialized and set to initialized=true');

  // 設定ドロップダウンメニュー
  settingsDropdown.initialize({
    buttonId: 'settings-btn',
    dropdownId: 'settings-dropdown',
  });

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
      settingsDropdown.close();
    });

    updateThemeIcon();
  }

  // ターミナルパネルのトグル（リサイズ機能含む）
  terminalPanelController.initialize({
    panelId: 'terminal-panel',
    toggleButtonId: 'toggle-terminal-btn',
    closeButtonId: 'close-terminal-btn',
    resizeHandleId: 'terminal-resize-handle',
    workbenchUpperSelector: '.workbench-upper',
    workbenchSelector: '.workbench',
    onFit: () => cTerminal?.fit(),
  });

  // xterm.js ターミナルの初期化
  const xtermContainer = document.getElementById('xterm-container');
  if (xtermContainer) {
    cTerminal = new CTerminal(xtermContainer);

    // 初期タブの言語に応じた説明を表示
    const initialTab = tabManager?.getActiveTab();
    const initialLanguage = initialTab?.language ?? 'c';
    showLanguageDescriptionInTerminal(initialLanguage);
    // ランタイムインジケーターを初期化
    runtimeManager.updateIndicator(initialLanguage);

    // ターミナル入力をハッシュチェーンに記録
    cTerminal.setInputCallback((input: string) => {
      eventRecorder?.record({
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

  // CodeExecutionControllerの初期化
  codeExecutionController.setTerminal(cTerminal!);
  codeExecutionController.setCallbacks({
    onRunStart: () => {
      runCodeBtn?.classList.add('running');
      stopCodeBtn?.classList.remove('hidden');
      clearEditorErrors();
      terminalPanelController.show();
    },
    onRunEnd: () => {
      runCodeBtn?.classList.remove('running');
      stopCodeBtn?.classList.add('hidden');
    },
    onNotification: showNotification,
    onRuntimeStatusChange: (language, state) => {
      runtimeManager.setStatus(language, state);
      // 現在選択中の言語の場合、インジケーターも更新
      const currentLanguage = (document.getElementById('language-selector') as HTMLSelectElement)?.value;
      if (currentLanguage === language || (language === 'c' && currentLanguage === 'cpp')) {
        runtimeManager.updateIndicator(currentLanguage);
      }
    },
    onShowClangLoading: showClangLoading,
    onHideClangLoading: hideClangLoading,
    onUpdateClangStatus: updateClangStatus,
    onRecordEvent: (event) => eventRecorder?.record({ type: event.type, description: event.description }),
    onShowErrors: showErrorsInEditor,
    onClearErrors: clearEditorErrors,
  });

  const handleRunCode = async (): Promise<void> => {
    const activeTab = tabManager?.getActiveTab();
    if (!activeTab) {
      showNotification('アクティブなタブがありません');
      return;
    }
    await codeExecutionController.run({
      language: activeTab.language,
      filename: activeTab.filename,
      code: activeTab.model.getValue(),
    });
  };

  const handleStopCode = (): void => {
    codeExecutionController.abort();
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

  // LogViewerPanelの初期化
  new LogViewerPanel({
    getLogViewer: () => logViewer,
    editorContainer: editorContainer!,
    toggleButtonId: 'toggle-log-btn',
    closeButtonId: 'close-log-btn',
    clearButtonId: 'clear-log-btn',
    resizeHandleId: 'log-resize-handle',
    panelId: 'log-viewer',
    eventCountSelector: '.status-item[title="Total events recorded"]',
  });

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
