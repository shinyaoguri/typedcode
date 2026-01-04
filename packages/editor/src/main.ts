// Check URL parameters for special actions
const urlParams = new URLSearchParams(window.location.search);

// Handle full reset request
if (urlParams.get('reset')) {
  console.log('[TypedCode] Reset parameter detected, clearing all data...');
  // Clear all storage synchronously before any other code runs
  try { localStorage.clear(); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  try {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
      if (name) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }
  } catch { /* ignore */ }
  try { indexedDB.deleteDatabase('typedcode-screenshots'); } catch { /* ignore */ }
  // Remove the reset parameter from URL
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);
  console.log('[TypedCode] All data cleared, URL cleaned');
}

// Check if this is a fresh window request (opened via "New Window" menu)
// If so, clear sessionStorage to start with a clean state
if (urlParams.get('fresh') === '1') {
  sessionStorage.removeItem('typedcode-tabs');
  // Remove the ?fresh=1 from URL without reloading
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);
}

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
import { initializeTrackers } from './tracking/TrackersInitializer.js';
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

// モジュールのインポート
import { configureMonacoWorkers } from './config/MonacoConfig.js';
import { WindowTracker } from './tracking/WindowTracker.js';
import { VisibilityTracker } from './tracking/VisibilityTracker.js';
import { NetworkTracker } from './tracking/NetworkTracker.js';
import { ScreenshotTracker } from './tracking/ScreenshotTracker.js';
import { ProcessingDialog } from './ui/components/ProcessingDialog.js';
import { ProofStatusDisplay } from './ui/components/ProofStatusDisplay.js';
import { CursorTracker } from './editor/CursorTracker.js';
import { EditorController } from './editor/EditorController.js';
import { SettingsDropdown } from './ui/components/SettingsDropdown.js';
import { DownloadDropdown } from './ui/components/DownloadDropdown.js';
import { MainMenuDropdown } from './ui/components/MainMenuDropdown.js';
import { TerminalPanel } from './ui/components/TerminalPanel.js';
import { CodeExecutionController } from './execution/CodeExecutionController.js';
import { ProofExporter } from './export/ProofExporter.js';
import { RuntimeManager } from './execution/RuntimeManager.js';
import { TabUIController } from './ui/tabs/TabUIController.js';
import { LogViewerPanel } from './ui/components/LogViewerPanel.js';
import { BrowserPreviewPanel } from './ui/components/BrowserPreviewPanel.js';
import { EventRecorder } from './core/EventRecorder.js';
import type { AppContext } from './core/AppContext.js';
import { isLanguageExecutable } from './config/SupportedLanguages.js';
import { t, getI18n, initDOMi18n } from './i18n/index.js';
import { showAboutDialog } from './ui/components/AboutDialog.js';

// i18n初期化（DOM翻訳を適用）
initDOMi18n();

// Monaco Editor の Worker 設定
configureMonacoWorkers();

// 利用規約関連の定数
const TERMS_ACCEPTED_KEY = 'typedcode-terms-accepted';
const TERMS_VERSION = '1.0';

// DOM要素の取得
const editorContainer = document.getElementById('editor');
if (!editorContainer) {
  throw new Error('Editor container not found');
}

// エディタの初期化
const editor: MonacoEditor = monaco.editor.create(editorContainer, {
  value: '',
  language: 'c',
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: { enabled: true },
  fontSize: 14,
  lineNumbers: 'on',
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  wrappingIndent: 'indent',
});

// アプリケーションコンテキストの初期化
const ctx: AppContext = {
  // Monaco Editor
  editor,
  themeManager: new ThemeManager(editor),

  // Tab Management (後で初期化)
  tabManager: null,
  tabUIController: null,

  // Logging (後で初期化)
  logViewer: null,

  // Trackers
  trackers: {
    window: new WindowTracker(),
    visibility: new VisibilityTracker(),
    keystroke: new KeystrokeTracker(),
    mouse: new MouseTracker({ throttleMs: 100 }),
    network: new NetworkTracker(),
    cursor: new CursorTracker({
      onCursorPositionUpdate: (lineNumber, column) => {
        const lineEl = document.getElementById('cursor-line');
        const colEl = document.getElementById('cursor-col');
        if (lineEl) lineEl.textContent = String(lineNumber);
        if (colEl) colEl.textContent = String(column);
      },
    }),
    operation: new OperationDetector(),
    screenshot: null,  // 許可取得後に初期化
  },
  editorController: new EditorController({
    operationDetector: new OperationDetector(),
    debug: import.meta.env.DEV,
  }),

  // Terminal & Execution
  terminal: null,
  codeExecution: new CodeExecutionController(),
  runtime: new RuntimeManager(),

  // Recording
  eventRecorder: null,
  proofExporter: new ProofExporter(),

  // UI Dialogs & Controls
  processingDialog: new ProcessingDialog(),
  proofStatusDisplay: new ProofStatusDisplay(),
  settingsDropdown: new SettingsDropdown(),
  downloadDropdown: new DownloadDropdown(),
  mainMenuDropdown: new MainMenuDropdown(),
  terminalPanel: new TerminalPanel(),
  browserPreviewPanel: new BrowserPreviewPanel(),

  // Flags
  skipBeforeUnload: false,
};

// ========================================
// ユーティリティ関数
// ========================================

function showNotification(message: string): void {
  const blockNotificationEl = document.getElementById('block-notification');
  const blockMessageEl = document.getElementById('block-message');
  if (blockMessageEl) blockMessageEl.textContent = message;
  blockNotificationEl?.classList.remove('hidden');
  setTimeout(() => {
    blockNotificationEl?.classList.add('hidden');
  }, 2000);
}

function showLanguageDescriptionInTerminal(language: string): void {
  if (!ctx.terminal) return;
  ctx.terminal.clear();

  // 言語の実行可否に応じてターミナルパネルの状態を更新
  const executable = isLanguageExecutable(language);
  ctx.terminalPanel.setTerminalAvailable(executable);

  const langDesc = ctx.runtime.getLanguageDescription(language);
  for (const line of langDesc) {
    ctx.terminal.writeLine(line);
  }
  ctx.terminal.writeLine('');
}

function updateProofStatus(): void {
  ctx.proofStatusDisplay.update();
}

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
      localStorage.setItem(TERMS_ACCEPTED_KEY, JSON.stringify({
        version: TERMS_VERSION,
        timestamp,
        agreedAt: new Date(timestamp).toISOString(),
      }));
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
 * 画面共有の許可を要求（画面全体が選択されるまで繰り返す）
 */
async function requestScreenCaptureWithRetry(tracker: ScreenshotTracker): Promise<boolean> {
  const maxAttempts = 10; // 無限ループ防止

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    updateInitMessage(t('screenCapture.requesting') ?? 'Requesting screen capture permission...');
    console.log(`[TypedCode] Requesting screen capture permission (attempt ${attempt})...`);

    const result = await tracker.requestPermissionAndAttach(true); // requireMonitor = true

    if (result.success) {
      return true;
    }

    if (result.error === 'monitor_required') {
      // タブやウィンドウが選択された場合、ユーザーに画面全体を選択するよう促す
      const surfaceName = result.displaySurface === 'window' ? 'ウィンドウ' : 'タブ';
      const shouldRetry = await showMonitorRequiredDialog(surfaceName);
      if (!shouldRetry) {
        console.log('[TypedCode] User cancelled screen capture');
        return false;
      }
      // ループを続行して再度許可を求める
      continue;
    }

    if (result.error === 'User denied screen capture permission') {
      // ユーザーがキャンセルした場合
      const shouldRetry = await showScreenCaptureRequiredDialog();
      if (!shouldRetry) {
        return false;
      }
      continue;
    }

    // その他のエラー
    console.error('[TypedCode] Screen capture error:', result.error);
    return false;
  }

  console.error('[TypedCode] Max screen capture attempts reached');
  return false;
}

/**
 * 画面全体の選択が必要であることを示すダイアログを表示
 */
async function showMonitorRequiredDialog(selectedType: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.getElementById('monitor-required-dialog');
    const retryBtn = document.getElementById('monitor-required-retry-btn');
    const cancelBtn = document.getElementById('monitor-required-cancel-btn');
    const selectedTypeEl = document.getElementById('monitor-selected-type');

    if (!dialog || !retryBtn || !cancelBtn) {
      // ダイアログが存在しない場合はalertで代用
      const retry = confirm(
        `「${selectedType}」が選択されました。\n\nTypedCodeでは画面全体の共有が必要です。\n「画面全体」または「モニター」を選択してください。\n\n再試行しますか？`
      );
      resolve(retry);
      return;
    }

    if (selectedTypeEl) {
      selectedTypeEl.textContent = selectedType;
    }

    dialog.classList.remove('hidden');

    const handleRetry = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(true);
    };

    const handleCancel = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(false);
    };

    const cleanup = (): void => {
      retryBtn.removeEventListener('click', handleRetry);
      cancelBtn.removeEventListener('click', handleCancel);
    };

    retryBtn.addEventListener('click', handleRetry);
    cancelBtn.addEventListener('click', handleCancel);
  });
}

/**
 * 画面共有が必要であることを示すダイアログを表示
 */
async function showScreenCaptureRequiredDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.getElementById('screen-capture-required-dialog');
    const retryBtn = document.getElementById('screen-capture-retry-btn');
    const cancelBtn = document.getElementById('screen-capture-cancel-btn');

    if (!dialog || !retryBtn || !cancelBtn) {
      // ダイアログが存在しない場合はalertで代用
      const retry = confirm(
        'TypedCodeを使用するには画面共有の許可が必要です。\n\n再試行しますか？'
      );
      resolve(retry);
      return;
    }

    dialog.classList.remove('hidden');

    const handleRetry = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(true);
    };

    const handleCancel = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(false);
    };

    const cleanup = (): void => {
      retryBtn.removeEventListener('click', handleRetry);
      cancelBtn.removeEventListener('click', handleCancel);
    };

    retryBtn.addEventListener('click', handleRetry);
    cancelBtn.addEventListener('click', handleCancel);
  });
}

/**
 * 画面共有停止時のロックオーバーレイを表示
 */
function showScreenCaptureLockOverlay(): void {
  let overlay = document.getElementById('screen-capture-lock-overlay');

  if (!overlay) {
    // オーバーレイが存在しない場合は動的に作成
    overlay = document.createElement('div');
    overlay.id = 'screen-capture-lock-overlay';
    overlay.className = 'screen-capture-lock-overlay';
    overlay.innerHTML = `
      <div class="screen-capture-lock-content">
        <i class="fas fa-desktop fa-3x"></i>
        <h2>${t('screenCapture.lockTitle') ?? '画面共有が停止されました'}</h2>
        <p>${t('screenCapture.lockDescription') ?? 'TypedCodeを使用するには画面全体の共有が必要です。'}</p>
        <button id="screen-capture-resume-btn" class="btn btn-primary">
          <i class="fas fa-play"></i>
          ${t('screenCapture.resumeButton') ?? '画面共有を再開'}
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  overlay.classList.remove('hidden');

  // 再開ボタンのイベントリスナー
  const resumeBtn = document.getElementById('screen-capture-resume-btn');
  resumeBtn?.addEventListener('click', async () => {
    const tracker = ctx.trackers.screenshot;
    if (tracker) {
      const result = await requestScreenCaptureWithRetry(tracker);
      if (result) {
        hideScreenCaptureLockOverlay();
      }
    }
  });
}

/**
 * 画面共有ロックオーバーレイを非表示
 */
function hideScreenCaptureLockOverlay(): void {
  const overlay = document.getElementById('screen-capture-lock-overlay');
  overlay?.classList.add('hidden');
}

// ========================================
// 初期化オーバーレイ
// ========================================

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
    setTimeout(() => initOverlay.remove(), 300);
  }
}

// ========================================
// タブ変更ハンドラ
// ========================================

function handleTabChange(tab: { filename: string; language: string; typingProof: unknown }): void {
  ctx.tabUIController?.updateUI();
  updateProofStatus();
  document.title = `${tab.filename} - TypedCode`;

  const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
  if (languageSelector) {
    languageSelector.value = tab.language;
  }

  showLanguageDescriptionInTerminal(tab.language);
  ctx.runtime.updateIndicator(tab.language);

  if (ctx.logViewer && ctx.tabManager) {
    const activeTab = ctx.tabManager.getActiveTab();
    if (activeTab) {
      ctx.logViewer.setTypingProof(activeTab.typingProof);
    }
  }
}

// ========================================
// イベントリスナーの設定
// ========================================

function setupStaticEventListeners(): void {
  // 言語切り替え
  const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
  languageSelector?.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    const activeTab = ctx.tabManager?.getActiveTab();
    if (activeTab) {
      ctx.tabManager?.setTabLanguage(activeTab.id, target.value);
      ctx.tabUIController?.updateUI();
      showLanguageDescriptionInTerminal(target.value);
      ctx.runtime.updateIndicator(target.value);
    }
  });

  // 新規タブ追加ボタン
  const addTabBtn = document.getElementById('add-tab-btn');
  addTabBtn?.addEventListener('click', async () => {
    if (!ctx.tabManager) return;

    if (isTurnstileConfigured()) {
      showNotification(t('notifications.authRunning'));
    }

    const num = ctx.tabUIController?.getNextUntitledNumber() ?? 1;
    const newTab = await ctx.tabManager.createTab(`Untitled-${num}`, 'c', '');

    if (!newTab) {
      showNotification(t('notifications.authFailed'));
      return;
    }

    await ctx.tabManager.switchTab(newTab.id);
    showNotification(t('notifications.newTabCreated'));
  });

  // 入力検出器の初期化
  new InputDetector(document.body, async (detectedEvent: DetectedEvent) => {
    showNotification(detectedEvent.message);
    console.log('[TypedCode] Detected operation:', detectedEvent);

    if (detectedEvent.type === 'paste' || detectedEvent.type === 'drop') {
      const position: CursorPosition | null = ctx.editor.getPosition();

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
            endColumn: position.column,
          },
          description: detectedEvent.type === 'paste' ?
            t('notifications.pasteDetected', { length: detectedEvent.data.length }) :
            t('notifications.dropDetected', { length: detectedEvent.data.length }),
        };

        ctx.eventRecorder?.record(event);
      }
    }
  });

  // リセット機能 - イベント委任を使用して確実にキャプチャ
  const resetDialog = document.getElementById('reset-dialog');

  // リセットボタン（設定メニュー内）をクリックしてダイアログを表示
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    document.getElementById('settings-dropdown')?.classList.remove('visible');
    resetDialog?.classList.remove('hidden');
  });

  // キャンセルボタン
  document.getElementById('reset-cancel-btn')?.addEventListener('click', () => {
    resetDialog?.classList.add('hidden');
  });

  // オーバーレイクリックで閉じる
  resetDialog?.addEventListener('click', (e) => {
    if (e.target === resetDialog) {
      resetDialog.classList.add('hidden');
    }
  });

  // Escキーで閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !resetDialog?.classList.contains('hidden')) {
      resetDialog?.classList.add('hidden');
    }
  });

  // リセット確認ボタン - イベント委任を使用
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // ボタン自体またはその子要素（アイコン、テキスト）がクリックされた場合
    const confirmBtn = target.closest('#reset-confirm-btn');
    if (!confirmBtn) return;

    e.preventDefault();
    e.stopPropagation();

    console.log('[TypedCode] Reset confirmed via event delegation');

    // ダイアログを閉じる
    resetDialog?.classList.add('hidden');

    // beforeunloadイベントをスキップ
    ctx.skipBeforeUnload = true;

    // ストレージをクリア
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }

    // Cookiesをクリア
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const eqPos = cookie.indexOf('=');
        const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
        if (name) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }
      }
    } catch { /* ignore */ }

    // IndexedDBを削除
    try { indexedDB.deleteDatabase('typedcode-screenshots'); } catch { /* ignore */ }

    // リロード（reset パラメータ付き）
    window.location.href = window.location.origin + window.location.pathname + '?reset=' + Date.now();
  });

  // ページ離脱時の確認ダイアログ
  window.addEventListener('beforeunload', (e) => {
    if (ctx.skipBeforeUnload) return;
    const activeProof = ctx.tabManager?.getActiveProof();
    if (activeProof && activeProof.events.length > 0) {
      e.preventDefault();
    }
  });

  // 現在のタブをZIPでエクスポート（ファイル + 検証ログ）
  const exportCurrentTabBtn = document.getElementById('export-current-tab-btn');
  exportCurrentTabBtn?.addEventListener('click', () => {
    ctx.downloadDropdown.close();
    void ctx.proofExporter.exportCurrentTab();
  });

  const exportZipBtn = document.getElementById('export-zip-btn');
  exportZipBtn?.addEventListener('click', () => {
    ctx.downloadDropdown.close();
    void ctx.proofExporter.exportAllTabsAsZip();
  });
}

// ========================================
// 初期化処理
// ========================================

async function initializeDeviceInfo(): Promise<{
  deviceId: string;
  fingerprintHash: string;
  fingerprintComponents: Awaited<ReturnType<typeof Fingerprint.collectComponents>>;
}> {
  updateInitMessage(t('notifications.gettingDeviceInfo'));
  const deviceId = await Fingerprint.getDeviceId();
  const fingerprintComponents = await Fingerprint.collectComponents();
  const fingerprintHash = await Fingerprint.generate();
  return { deviceId, fingerprintHash, fingerprintComponents };
}

async function initializeTabManager(
  fingerprintHash: string,
  fingerprintComponents: Awaited<ReturnType<typeof Fingerprint.collectComponents>>
): Promise<boolean> {
  ctx.tabManager = new TabManager(ctx.editor);

  const editorTabsContainer = document.getElementById('editor-tabs');
  if (editorTabsContainer) {
    ctx.tabUIController = new TabUIController({
      container: editorTabsContainer,
      tabManager: ctx.tabManager,
      basePath: import.meta.env.BASE_URL,
      onNotification: showNotification,
    });
  }

  // ProofExporterの初期化
  ctx.proofExporter.setTabManager(ctx.tabManager);
  ctx.proofExporter.setProcessingDialog(ctx.processingDialog);
  ctx.proofExporter.setCallbacks({ onNotification: showNotification });
  if (ctx.trackers.screenshot) {
    ctx.proofExporter.setScreenshotTracker(ctx.trackers.screenshot);
  }

  // ProofStatusDisplayのコールバックを設定
  ctx.proofStatusDisplay.setGetStats(() => {
    const activeProof = ctx.tabManager?.getActiveProof();
    if (!activeProof) return null;
    return activeProof.getStats();
  });

  ctx.proofStatusDisplay.setSnapshotCallback(
    (content) => {
      const activeProof = ctx.tabManager?.getActiveProof();
      if (!activeProof) return Promise.reject(new Error('No active proof'));
      return activeProof.recordContentSnapshot(content);
    },
    () => ctx.editor.getValue()
  );

  // タブ変更コールバックを設定
  ctx.tabManager.setOnTabChange((tab, previousTab) => {
    console.log('[TypedCode] Tab switched:', previousTab?.filename, '->', tab.filename);
    handleTabChange(tab);

    // ScreenshotTrackerのstartTimeを新しいタブのTypingProofに合わせて更新
    if (ctx.trackers.screenshot) {
      ctx.trackers.screenshot.setProofStartTime(tab.typingProof.startTime);
    }
  });

  ctx.tabManager.setOnTabUpdate(() => {
    ctx.tabUIController?.updateUI();
    const activeTab = ctx.tabManager?.getActiveTab();
    if (activeTab) {
      document.title = `${activeTab.filename} - TypedCode`;
    }
  });

  ctx.tabManager.setOnVerification(() => {
    ctx.tabUIController?.updateUI();
  });

  updateInitMessage(t('notifications.initializingEditor'));
  const initialized = await ctx.tabManager.initialize(fingerprintHash, fingerprintComponents);
  return initialized;
}

function initializeLogViewer(): void {
  const logEntriesContainer = document.getElementById('log-entries');
  if (!logEntriesContainer) {
    console.error('[TypedCode] log-entries not found!');
    return;
  }

  const initialProof = ctx.tabManager?.getActiveProof();
  if (initialProof) {
    ctx.logViewer = new LogViewer(logEntriesContainer, initialProof);

    // スクリーンショットストレージを設定（プレビュー表示用）
    if (ctx.trackers.screenshot) {
      ctx.logViewer.setScreenshotStorage(ctx.trackers.screenshot.getStorageService());
    }
  }
}

function initializeEventRecorder(): void {
  ctx.eventRecorder = new EventRecorder({
    tabManager: ctx.tabManager!,
    logViewer: ctx.logViewer,
    onStatusUpdate: () => updateProofStatus(),
    onError: (msg) => showNotification(msg),
  });
  ctx.eventRecorder.setInitialized(true);
}

function initializeTerminal(): void {
  ctx.settingsDropdown.initialize({
    buttonId: 'settings-btn',
    dropdownId: 'settings-dropdown',
  });

  ctx.downloadDropdown.initialize({
    buttonId: 'download-menu-btn',
    dropdownId: 'download-dropdown',
  });

  ctx.mainMenuDropdown.initialize({
    buttonId: 'main-menu-btn',
    dropdownId: 'main-menu-dropdown',
  });

  // メインメニューのイベントハンドラー
  const newFileBtn = document.getElementById('new-file-btn');
  newFileBtn?.addEventListener('click', async () => {
    ctx.mainMenuDropdown.close();
    if (!ctx.tabManager) return;

    if (isTurnstileConfigured()) {
      showNotification(t('notifications.authRunning'));
    }

    const num = ctx.tabUIController?.getNextUntitledNumber() ?? 1;
    const newTab = await ctx.tabManager.createTab(`Untitled-${num}`, 'c', '');

    if (!newTab) {
      showNotification(t('notifications.authFailed'));
      return;
    }

    await ctx.tabManager.switchTab(newTab.id);
    showNotification(t('notifications.newTabCreated'));
  });

  const newWindowBtn = document.getElementById('new-window-btn');
  newWindowBtn?.addEventListener('click', () => {
    ctx.mainMenuDropdown.close();
    // Open a fresh window with ?fresh=1 to signal that sessionStorage should be cleared
    window.open(window.location.origin + window.location.pathname + '?fresh=1', '_blank');
  });

  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (themeToggleBtn) {
    const updateThemeIcon = (): void => {
      const icon = themeToggleBtn.querySelector('i');
      if (icon) {
        icon.className = ctx.themeManager.isLight() ? 'fas fa-sun' : 'fas fa-moon';
      }
    };

    themeToggleBtn.addEventListener('click', () => {
      ctx.themeManager.toggle();
      updateThemeIcon();
      ctx.settingsDropdown.close();
    });

    updateThemeIcon();
  }

  // 言語切り替えボタン
  const languageToggleBtn = document.getElementById('language-toggle-btn');
  const currentLanguageLabel = document.getElementById('current-language-label');
  if (languageToggleBtn && currentLanguageLabel) {
    // 現在の言語を表示
    const i18n = getI18n();
    currentLanguageLabel.textContent = i18n.getLocaleDisplayName(i18n.getLocale());

    languageToggleBtn.addEventListener('click', () => {
      const currentLocale = i18n.getLocale();
      const newLocale = currentLocale === 'ja' ? 'en' : 'ja';
      i18n.setLocale(newLocale);
      ctx.settingsDropdown.close();
      window.location.reload();
    });
  }

  // About ボタン
  const aboutBtn = document.getElementById('about-btn');
  if (aboutBtn) {
    aboutBtn.addEventListener('click', () => {
      ctx.settingsDropdown.close();
      showAboutDialog(getI18n());
    });
  }

  ctx.terminalPanel.initialize({
    panelId: 'terminal-panel',
    toggleButtonId: 'toggle-terminal-btn',
    closeButtonId: 'close-terminal-btn',
    resizeHandleId: 'terminal-resize-handle',
    workbenchUpperSelector: '.workbench-upper',
    workbenchSelector: '.workbench',
    onFit: () => ctx.terminal?.fit(),
  });

  const xtermContainer = document.getElementById('xterm-container');
  if (xtermContainer) {
    ctx.terminal = new CTerminal(xtermContainer);

    const initialTab = ctx.tabManager?.getActiveTab();
    const initialLanguage = initialTab?.language ?? 'c';
    showLanguageDescriptionInTerminal(initialLanguage);
    ctx.runtime.updateIndicator(initialLanguage);

    ctx.terminal.setInputCallback((input: string) => {
      ctx.eventRecorder?.record({
        type: 'terminalInput',
        description: `${t('events.terminalInput')}: ${input}`,
      });
    });
  }
}

function initializeCodeExecution(): void {
  const runCodeBtn = document.getElementById('run-code-btn');
  const stopCodeBtn = document.getElementById('stop-code-btn');
  const clangLoadingOverlay = document.getElementById('clang-loading-overlay');
  const clangStatus = document.getElementById('clang-status');

  const showClangLoading = (): void => clangLoadingOverlay?.classList.remove('hidden');
  const hideClangLoading = (): void => clangLoadingOverlay?.classList.add('hidden');
  const updateClangStatus = (message: string): void => {
    if (clangStatus) clangStatus.textContent = message;
  };

  const showErrorsInEditor = (errors: ParsedError[]): void => {
    const activeTab = ctx.tabManager?.getActiveTab();
    if (!activeTab) return;

    const markers = errors.map((err) => ({
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
    const activeTab = ctx.tabManager?.getActiveTab();
    if (activeTab) {
      monaco.editor.setModelMarkers(activeTab.model, 'c-compiler', []);
    }
  };

  ctx.codeExecution.setTerminal(ctx.terminal!);
  ctx.codeExecution.setCallbacks({
    onRunStart: () => {
      runCodeBtn?.classList.add('running');
      stopCodeBtn?.classList.remove('hidden');
      clearEditorErrors();
      ctx.terminalPanel.show();
    },
    onRunEnd: () => {
      runCodeBtn?.classList.remove('running');
      stopCodeBtn?.classList.add('hidden');
    },
    onNotification: showNotification,
    onRuntimeStatusChange: (language, state) => {
      ctx.runtime.setStatus(language, state);
      const currentLanguage = (document.getElementById('language-selector') as HTMLSelectElement)?.value;
      if (currentLanguage === language || (language === 'c' && currentLanguage === 'cpp')) {
        ctx.runtime.updateIndicator(currentLanguage);
      }
    },
    onShowClangLoading: showClangLoading,
    onHideClangLoading: hideClangLoading,
    onUpdateClangStatus: updateClangStatus,
    onRecordEvent: (event) => ctx.eventRecorder?.record({ type: event.type, description: event.description }),
    onShowErrors: showErrorsInEditor,
    onClearErrors: clearEditorErrors,
  });

  const handleRunCode = async (): Promise<void> => {
    const activeTab = ctx.tabManager?.getActiveTab();
    if (!activeTab) {
      showNotification(t('notifications.noActiveTab'));
      return;
    }
    await ctx.codeExecution.run({
      language: activeTab.language,
      filename: activeTab.filename,
      code: activeTab.model.getValue(),
    });
  };

  const handleStopCode = (): void => {
    ctx.codeExecution.abort();
  };

  runCodeBtn?.addEventListener('click', () => void handleRunCode());
  stopCodeBtn?.addEventListener('click', handleStopCode);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      void handleRunCode();
    }
  });

  // LogViewerPanelの初期化
  new LogViewerPanel({
    getLogViewer: () => ctx.logViewer,
    editorContainer: editorContainer!,
    toggleButtonId: 'toggle-log-btn',
    closeButtonId: 'close-log-btn',
    clearButtonId: 'clear-log-btn',
    resizeHandleId: 'log-resize-handle',
    panelId: 'log-viewer',
    eventCountSelector: '.status-item[title="Total events recorded"]',
  });

  // BrowserPreviewPanelの初期化
  ctx.browserPreviewPanel.initialize({
    panelId: 'browser-preview',
    toggleButtonId: 'toggle-preview-btn',
    closeButtonId: 'close-preview-btn',
    refreshButtonId: 'refresh-preview-btn',
    resizeHandleId: 'preview-resize-handle',
    editorContainer: editorContainer!,
    getTabManager: () => ctx.tabManager,
  });

  const copyCodeBtn = document.getElementById('copy-code-btn');
  copyCodeBtn?.addEventListener('click', async () => {
    try {
      const code = ctx.editor.getValue();
      await navigator.clipboard.writeText(code);
      copyCodeBtn.classList.add('copied');
      showNotification(t('notifications.codeCopied'));
      setTimeout(() => copyCodeBtn.classList.remove('copied'), 2000);
    } catch (error) {
      console.error('[TypedCode] Copy failed:', error);
      showNotification(t('notifications.copyFailed'));
    }
  });
}

function recordTermsAcceptance(): void {
  const activeProofForTerms = ctx.tabManager?.getActiveProof();
  if (!activeProofForTerms) return;

  const termsData = localStorage.getItem(TERMS_ACCEPTED_KEY);
  if (!termsData) return;

  try {
    const parsed = JSON.parse(termsData);
    const hasTermsEvent = activeProofForTerms.events.some((e: { type: string }) => e.type === 'termsAccepted');
    if (!hasTermsEvent) {
      activeProofForTerms.recordEvent({
        type: 'termsAccepted',
        data: {
          version: parsed.version,
          timestamp: parsed.timestamp,
          agreedAt: parsed.agreedAt,
        },
        description: `Terms v${parsed.version} accepted`,
      }).then(() => {
        console.log('[TypedCode] Terms acceptance recorded to hash chain');
        ctx.tabManager?.saveToStorage();
      }).catch((err: unknown) => {
        console.error('[TypedCode] Failed to record terms acceptance:', err);
      });
    }
  } catch (err) {
    console.error('[TypedCode] Failed to parse terms data:', err);
  }
}

// ========================================
// データクリア関数
// ========================================

/**
 * アプリケーションに関連する全てのデータを完全にクリア
 * - localStorage
 * - sessionStorage
 * - IndexedDB (スクリーンショット等)
 * - Cookies
 * - Service Worker Cache
 */
async function clearAllAppData(): Promise<void> {
  console.log('[TypedCode] Clearing all app data...');

  // 1. localStorage をクリア
  try {
    localStorage.clear();
    console.log('[TypedCode] localStorage cleared');
  } catch (e) {
    console.warn('[TypedCode] Failed to clear localStorage:', e);
  }

  // 2. sessionStorage をクリア
  try {
    sessionStorage.clear();
    console.log('[TypedCode] sessionStorage cleared');
  } catch (e) {
    console.warn('[TypedCode] Failed to clear sessionStorage:', e);
  }

  // 3. IndexedDB をクリア（全てのデータベース）
  try {
    // 既知のデータベース名
    const dbNames = ['typedcode-screenshots'];

    for (const dbName of dbNames) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => {
          console.log(`[TypedCode] IndexedDB "${dbName}" deleted`);
          resolve();
        };
        request.onerror = () => {
          console.warn(`[TypedCode] Failed to delete IndexedDB "${dbName}"`);
          resolve();
        };
        request.onblocked = () => {
          console.warn(`[TypedCode] IndexedDB "${dbName}" deletion blocked`);
          resolve();
        };
      });
    }

    // indexedDB.databases() が利用可能な場合、全てのデータベースを削除
    if ('databases' in indexedDB) {
      const databases = await indexedDB.databases();
      for (const db of databases) {
        if (db.name && db.name.startsWith('typedcode')) {
          await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(db.name!);
            request.onsuccess = () => {
              console.log(`[TypedCode] IndexedDB "${db.name}" deleted`);
              resolve();
            };
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          });
        }
      }
    }
  } catch (e) {
    console.warn('[TypedCode] Failed to clear IndexedDB:', e);
  }

  // 4. Cookies をクリア（このドメインのもの）
  try {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
      if (name) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }
    console.log('[TypedCode] Cookies cleared');
  } catch (e) {
    console.warn('[TypedCode] Failed to clear cookies:', e);
  }

  // 5. Service Worker Cache をクリア
  try {
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      for (const cacheName of cacheNames) {
        await caches.delete(cacheName);
        console.log(`[TypedCode] Cache "${cacheName}" deleted`);
      }
    }
  } catch (e) {
    console.warn('[TypedCode] Failed to clear caches:', e);
  }

  // 6. 画面共有を停止
  try {
    ctx.trackers.screenshot?.dispose();
    console.log('[TypedCode] Screenshot tracker disposed');
  } catch (e) {
    console.warn('[TypedCode] Failed to dispose screenshot tracker:', e);
  }

  console.log('[TypedCode] All app data cleared');
}

// ========================================
// メイン初期化関数
// ========================================

async function initializeApp(): Promise<void> {
  // Phase 1: 利用規約の確認
  if (!hasAcceptedTerms()) {
    initOverlay?.classList.add('hidden');
    await showTermsModal();
    initOverlay?.classList.remove('hidden');
    updateInitMessage(t('app.initializing'));
  }

  // Phase 1.5: Screen Capture許可の取得（画面全体のみ許可）
  if (ScreenshotTracker.isSupported()) {
    const screenshotTracker = new ScreenshotTracker();
    const permissionGranted = await requestScreenCaptureWithRetry(screenshotTracker);

    if (!permissionGranted) {
      // 画面共有が得られなかった場合はアプリを使用不能に
      showScreenCaptureLockOverlay();
      return;
    }

    // ストリーム停止時のコールバックを設定
    screenshotTracker.setStreamStoppedCallback(() => {
      showScreenCaptureLockOverlay();
    });

    ctx.trackers.screenshot = screenshotTracker;
  } else {
    // 非対応ブラウザでは続行を許可するが警告を表示
    showNotification(t('screenCapture.notSupported') ?? 'Screen Capture not supported in this browser');
  }

  // Phase 2: バックグラウンド初期化
  // ランタイム状態変更時のコールバックを設定
  ctx.runtime.setCallbacks({
    onStatusChange: (language, _state) => {
      const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
      const currentLanguage = languageSelector?.value;
      if (currentLanguage === language || (language === 'c' && currentLanguage === 'cpp')) {
        ctx.runtime.updateIndicator(currentLanguage);
      }
    },
  });

  ctx.runtime.initializeCRuntime().catch(() => {
    // Background initialization failed, but continue
  });

  if (isTurnstileConfigured()) {
    preloadTurnstile().catch(() => {
      // Turnstile preload failed, but continue
    });
  }

  // Phase 3: デバイス情報取得
  const { fingerprintHash, fingerprintComponents } = await initializeDeviceInfo();

  // Phase 4: TabManager初期化
  const initialized = await initializeTabManager(fingerprintHash, fingerprintComponents);

  if (!initialized) {
    updateInitMessage(t('notifications.authFailedReload'));
    showNotification(t('notifications.authFailedReload'));
    return;
  }

  hideInitOverlay();
  ctx.tabUIController?.updateUI();

  // 言語セレクタを更新
  const activeTab = ctx.tabManager?.getActiveTab();
  const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
  if (activeTab && languageSelector) {
    languageSelector.value = activeTab.language;
  }

  updateProofStatus();

  // 利用規約同意をハッシュチェーンに記録
  recordTermsAcceptance();

  // Phase 5: トラッカーの初期化
  initializeTrackers({
    ctx,
    editorContainer: editorContainer!,
    recordEvent: (event) => ctx.eventRecorder?.record(event),
    recordEventToAllTabs: (event) => ctx.eventRecorder?.recordToAllTabs(event),
    onProofStatusUpdate: updateProofStatus,
    onStorageSave: () => ctx.tabManager?.saveToStorage(),
  });

  // Phase 6: LogViewerとEventRecorderの初期化
  initializeLogViewer();
  initializeEventRecorder();

  // Phase 7: ターミナルとコード実行の初期化
  initializeTerminal();
  initializeCodeExecution();

  // Phase 8: セッション再開イベントの記録（リロード時）
  // sessionStorageにタブデータが存在していた場合はリロードによる再開
  const wasReloaded = sessionStorage.getItem('typedcode-tabs') !== null &&
                      sessionStorage.getItem('typedcode-screenshot-session') === 'active';
  if (wasReloaded) {
    // セッション再開イベントを全タブに記録
    ctx.eventRecorder?.recordToAllTabs({
      type: 'sessionResumed',
      data: {
        timestamp: performance.now(),
        previousEventCount: ctx.tabManager?.getActiveProof()?.events.length ?? 0,
      },
      description: t('events.sessionResumed'),
    });
    console.log('[TypedCode] Session resumed after reload');
  }

  console.log('[TypedCode] App initialized successfully');
}

// DOMContentLoaded または即座に実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // 静的イベントリスナーを設定（DOM準備後）
    setupStaticEventListeners();
    void initializeApp();
  });
} else {
  // 静的イベントリスナーを設定（DOM準備後）
  setupStaticEventListeners();
  void initializeApp();
}

// エディタインスタンスをエクスポート（拡張用）
export { editor, monaco };
