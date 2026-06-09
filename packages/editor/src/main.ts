// Check URL parameters for special actions
const urlParams = new URLSearchParams(window.location.search);

// モード (ADR-0011): URL パスでモードを確定する (`/exam` `/class` `/assignment`、他は casual)。
// sticky は持たない — path はリロードで永続し、試験の整合性は封印の暗号束縛 (ADR-0006) が担保する。
// ストレージはモード別に名前空間化する (PR3) ので、モード間でセッションが混ざらず共存できる
// (PR1/PR2 の「モード切替時 auto-clear」を置換)。**NS は最初期に確定**させる — 以降の storage
// 参照 (?reset/?fresh 含む) が storageKeys の getter を使うため。
const mode = resolveModeFromPath(window.location.pathname);
setStorageNamespace(mode);
const examMode = mode === 'exam';

// 機能別アクセント (要望): 作成アプリは data-feature=editor、色はモードで切替 (data-mode)。
document.documentElement.setAttribute('data-feature', 'editor');
document.documentElement.setAttribute('data-mode', mode);

// 全消去リクエスト (?reset): 全モードのデータを消す手動ユーティリティ (sticky 解除用ではない)。
if (urlParams.get('reset')) {
  console.log('[TypedCode] Reset parameter detected, clearing all data...');
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
  for (const db of allSessionDbNames()) {
    try { indexedDB.deleteDatabase(db); } catch { /* ignore */ }
  }
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);
  console.log('[TypedCode] All data cleared, URL cleaned');
}

// 新規ウィンドウ (?fresh=1): 現モードのタブ状態だけクリアして clean に始める。
if (urlParams.get('fresh') === '1') {
  sessionStorage.removeItem(tabsKey());
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);
}

import * as monaco from 'monaco-editor';
import './styles/main.css';
import {
  Fingerprint,
  setSharedDebug,
  decodeExamPlaintext,
  computeProblemContentHash,
  computeBundleProblemHash,
  computeHash,
  type ExamSessionContext,
  type ExamBundleProblem,
  type ExamPackageManifest,
  type HumanAttestationEventData,
  type ClassPackage,
} from '@typedcode/shared';
import { resolveModeFromPath, capabilitiesFor } from './core/mode.js';
import { setStorageNamespace, tabsKey, sessionActiveKey, allSessionDbNames } from './core/storageKeys.js';
import { OperationDetector } from './tracking/OperationDetector.js';
import { KeystrokeTracker } from './tracking/KeystrokeTracker.js';
import { MouseTracker } from './tracking/MouseTracker.js';
import { initializeTrackers } from './tracking/TrackersInitializer.js';
import { ThemeManager } from './editor/ThemeManager.js';
import { TabManager, type SyncStatus, type TabState } from './ui/tabs/TabManager.js';
import type { MonacoEditor } from './editor/types.js';
import {
  isTurnstileConfigured,
  loadTurnstileScript as preloadTurnstile,
} from './services/TurnstileService.js';
import {
  SingleInstanceGuard,
  showDuplicateInstanceOverlay,
  showUnsupportedBrowserOverlay,
} from './services/SingleInstanceGuard.js';
import { CTerminal } from './terminal/CTerminal.js';
import type { ParsedError } from './executors/c/CExecutor.js';
import '@xterm/xterm/css/xterm.css';

// モジュールのインポート
import { configureMonacoWorkers } from './config/MonacoConfig.js';
import { WindowTracker } from './tracking/WindowTracker.js';
import { VisibilityTracker } from './tracking/VisibilityTracker.js';
import { NetworkTracker } from './tracking/NetworkTracker.js';
import { EnvironmentTracker } from './tracking/EnvironmentTracker.js';
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
import { ProblemPanel } from './ui/components/ProblemPanel.js';
import { ExamStartGate } from './ui/components/ExamStartGate.js';
import { ExamPackageStore } from './services/ExamPackageStore.js';
import { ClassProblemLoader } from './ui/components/ClassProblemLoader.js';
import { ClassProblemStore } from './services/ClassProblemStore.js';
import { FullscreenTracker } from './tracking/FullscreenTracker.js';
import { EventRecorder, SessionContentRegistry } from './core/index.js';
import type { AppContext } from './core/AppContext.js';
import { t, getI18n, initDOMi18n } from './i18n/index.js';
import { showAboutDialog } from './ui/components/AboutDialog.js';
import { TitlebarClock } from './ui/components/TitlebarClock.js';
import { IdleTimeoutManager } from './tracking/IdleTimeoutManager.js';
import {
  showIdleWarningDialog,
  showIdleSuspendedOverlay,
  hideIdleSuspendedOverlay,
} from './ui/dialogs/IdleTimeoutDialogs.js';
import {
  requestScreenCaptureWithRetry,
  showScreenCaptureLockOverlay,
  hideScreenCaptureLockOverlay,
  showScreenShareChoiceDialog,
  showScreenShareOptOutConfirmDialog,
  showScreenShareOptOutBanner,
  hideScreenShareOptOutBanner,
} from './ui/dialogs/ScreenCaptureDialogs.js';
import { initSessionStorageService } from './services/SessionStorageService.js';
import { showSessionRecoveryDialog } from './ui/dialogs/SessionRecoveryDialog.js';

// shared ライブラリのトレースログは dev サーバ時のみ有効化 (本番は no-op)。
setSharedDebug(import.meta.env.DEV);

// App モジュールからのインポート
import {
  showNotification,
  initializeLogViewer,
  updateProofStatus,
  showLanguageDescriptionInTerminal,
  handleTabChange,
  setupStaticEventListeners,
  showWelcomeScreen,
  hasAcceptedTerms,
  showTermsModal,
  handleTemplateImport,
} from './app/index.js';
import type { WelcomeScreen } from './ui/components/WelcomeScreen.js';

// i18n初期化（DOM翻訳を適用）
initDOMi18n();

// 機能バッジ (ぱっと見で機能/モードを判別): titlebar にモード名のピルを挿入。
{
  const icon: Record<string, string> = {
    casual: 'fa-pen', class: 'fa-chalkboard-user', assignment: 'fa-house-laptop', exam: 'fa-lock',
  };
  const badge = document.createElement('span');
  badge.className = 'feature-badge';
  badge.innerHTML = `<i class="fas ${icon[mode] ?? 'fa-pen'}"></i> ${t(`feature.${mode}`)}`;
  document.querySelector('.titlebar-left')?.appendChild(badge);
}

// Monaco Editor の Worker 設定
configureMonacoWorkers();

/**
 * IndexedDB同期状態のUIを更新
 */
function updateSyncStatusUI(status: SyncStatus): void {
  const syncStatusItem = document.getElementById('sync-status-item');
  const syncStatusText = document.getElementById('sync-status');

  if (!syncStatusItem || !syncStatusText) return;

  // クラスをリセット
  syncStatusItem.classList.remove('synced', 'syncing', 'pending');
  syncStatusItem.classList.add(status);

  // テキストを更新
  const statusTexts: Record<SyncStatus, string> = {
    synced: t('statusBar.synced'),
    syncing: t('statusBar.syncing'),
    pending: t('statusBar.pending'),
  };
  syncStatusText.textContent = statusTexts[status];
}

// 利用規約関連の定数
const TERMS_ACCEPTED_KEY = 'typedcode-terms-accepted';

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
    environment: new EnvironmentTracker(),
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
  problemPanel: new ProblemPanel(),
  fullscreenTracker: new FullscreenTracker(),

  // Flags
  skipBeforeUnload: false,
  examMode,
  mode,
  capabilities: capabilitiesFor(mode),

  // Welcome Screen
  welcomeScreen: null as WelcomeScreen | null,

  // Titlebar Clock
  titlebarClock: new TitlebarClock(),

  // Idle Timeout Manager
  idleTimeoutManager: null,

  // Session Content Registry (for internal paste detection)
  contentRegistry: new SessionContentRegistry(),
};

// proof に生成時のモードを記録する (ADR-0011: 自己申告ラベル、全モード共通)。
ctx.proofExporter.setMode(ctx.mode);
// export 前認証の best-effort 化はモード能力で決まる (ADR-0006: exam のみ。サーバを critical path に置かない)。
ctx.proofExporter.setPreExportBestEffort(ctx.capabilities.preExportBestEffort);

// exam 固有のクロム (タブ追加/削除・汎用DLメニューの非表示、unify) は body.exam-mode が駆動する。
if (ctx.examMode) {
  document.body.classList.add('exam-mode');
}

// 問題表示モード (exam / class): 問題パネルを表示し、ログDLボタンを配線する。
// Monaco は automaticLayout: true なのでパネル出現に伴う再レイアウトは自動。
// class は封印を持たない平文配布 (ADR-0014) だが、表示・DL の UI は exam と共通。
if (ctx.capabilities.problemPanel) {
  // 問題パネルのトグルボタン (左 Activity Bar) を出すための CSS フック。
  document.body.classList.add('has-problem-panel');
  // ProblemPanel.initialize() がリサイズ/クローズ/トグルを内部で配線する。
  if (ctx.problemPanel.initialize()) {
    ctx.problemPanel.show();
  }
  // 提出用ログのダウンロード導線 (全タブ ZIP = 証明 + コード)。提出は Moodle で行うため
  // TypedCode 側に「提出」操作は持たない。exam では unify で左の汎用DLメニューを隠し一本化する。
  document.getElementById('download-log-btn')?.addEventListener('click', () => {
    void ctx.proofExporter.exportAllTabsAsZip();
  });
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
    handleTabChange(ctx, tab);

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

  // 同期状態変更コールバックを設定
  ctx.tabManager.setOnSyncStatusChange((status: SyncStatus) => {
    updateSyncStatusUI(status);
  });

  updateInitMessage(t('notifications.initializingEditor'));
  const initialized = await ctx.tabManager.initialize(fingerprintHash, fingerprintComponents);

  // ContentRegistryに全タブのコンテンツ取得コールバックを設定
  // これにより、ペースト時に全タブのコンテンツから内部ペーストを判定できる
  ctx.contentRegistry.setGetAllContentsCallback(() => {
    const tabs = ctx.tabManager?.getAllTabs() ?? [];
    return tabs.map(tab => tab.model.getValue());
  });

  return initialized;
}

function initializeEventRecorder(): void {
  ctx.eventRecorder = new EventRecorder({
    tabManager: ctx.tabManager!,
    getLogViewer: () => ctx.logViewer,
    onStatusUpdate: () => updateProofStatus(ctx),
    onError: (msg) => showNotification(msg),
  });
  ctx.eventRecorder.setInitialized(true);
}

function initializeIdleTimeoutManager(): void {
  // 開発モードでは短いタイムアウトでテスト可能
  const DEBUG_MODE = import.meta.env.DEV && false; // 必要に応じてtrueに変更

  ctx.idleTimeoutManager = new IdleTimeoutManager({
    idleTimeoutMs: DEBUG_MODE ? 10 * 1000 : 60 * 60 * 1000, // 10秒 vs 1時間
    warningTimeoutMs: DEBUG_MODE ? 30 * 1000 : 5 * 60 * 1000, // 30秒 vs 5分
  });

  // UIコールバック設定
  ctx.idleTimeoutManager.setUICallbacks({
    showWarningDialog: () =>
      showIdleWarningDialog(DEBUG_MODE ? 30 * 1000 : 5 * 60 * 1000),
    showSuspendedOverlay: () =>
      showIdleSuspendedOverlay(() => {
        ctx.idleTimeoutManager?.resume();
      }),
    hideSuspendedOverlay: hideIdleSuspendedOverlay,
  });

  // 記録制御コールバック設定
  ctx.idleTimeoutManager.setCallbacks({
    onSuspend: () => {
      // 記録を一時停止
      ctx.eventRecorder?.setEnabled(false);
      // スクリーンショット撮影を停止
      ctx.trackers.screenshot?.setCaptureEnabled(false);
      console.log('[TypedCode] Recording suspended due to idle timeout');
    },
    onResume: () => {
      // 記録を再開
      ctx.eventRecorder?.setEnabled(true);
      // スクリーンショット撮影を再開（タブがある場合のみ）
      if (ctx.tabManager?.hasAnyTabs()) {
        ctx.trackers.screenshot?.setCaptureEnabled(true);
      }
      console.log('[TypedCode] Recording resumed');
    },
    onStateChange: (state) => {
      console.log('[TypedCode] Idle state changed:', state);
    },
  });

  console.log('[TypedCode] IdleTimeoutManager initialized');
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
  ctx.downloadDropdown.setHasTabsCallback(() => ctx.tabManager?.hasAnyTabs() ?? false);

  ctx.mainMenuDropdown.initialize({
    buttonId: 'main-menu-btn',
    dropdownId: 'main-menu-dropdown',
  });

  // メインメニューのイベントハンドラー
  const newFileBtn = document.getElementById('new-file-btn');
  newFileBtn?.addEventListener('click', async () => {
    ctx.mainMenuDropdown.close();
    if (ctx.capabilities.tabLock) return; // タブ固定モード (試験) では新規ファイル不可 (ADR-0010/0011)
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

  // テンプレートインポートボタン
  const importTemplateBtn = document.getElementById('import-template-btn');
  importTemplateBtn?.addEventListener('click', async () => {
    ctx.mainMenuDropdown.close();
    if (!ctx.tabManager) return;

    try {
      await handleTemplateImport(ctx);
    } catch (error) {
      console.error('[TemplateImport] Error:', error);
      showNotification(t('template.error'));
    }
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
    resetButtonId: 'reset-runtime-btn',
    resizeHandleId: 'terminal-resize-handle',
    workbenchUpperSelector: '.workbench-upper',
    workbenchSelector: '.workbench',
    onFit: () => ctx.terminal?.fit(),
    onResetRuntime: async () => {
      const activeTab = ctx.tabManager?.getActiveTab();
      if (activeTab && (activeTab.language === 'c' || activeTab.language === 'cpp')) {
        ctx.terminal?.writeInfo(t('terminal.runtimeResetting') + '\n');
        try {
          await ctx.runtime.resetCRuntime();
          ctx.terminal?.writeSuccess(t('terminal.runtimeResetComplete') + '\n');
          ctx.runtime.updateIndicator(activeTab.language);
        } catch (error) {
          ctx.terminal?.writeError(`Reset failed: ${error}\n`);
        }
      } else {
        ctx.terminal?.writeInfo('No runtime reset needed for this language.\n');
      }
    },
  });

  const xtermContainer = document.getElementById('xterm-container');
  if (xtermContainer) {
    ctx.terminal = new CTerminal(xtermContainer);

    const initialTab = ctx.tabManager?.getActiveTab();
    const initialLanguage = initialTab?.language ?? 'c';
    showLanguageDescriptionInTerminal(ctx, initialLanguage);
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
// 試験モード (ADR-0006) の解錠フロー
// ========================================

/** 言語 ID → ファイル拡張子 (exam タブのファイル名生成用) */
function examFileExtension(language: string): string {
  const map: Record<string, string> = {
    c: 'c', cpp: 'cpp', python: 'py', javascript: 'js', typescript: 'ts',
  };
  return map[language] ?? language;
}

/**
 * 初回入場: ブロック型ゲートで封印問題を開封し、exam タブを生成する。
 * 平文を decode し、N問バンドル (ADR-0012) なら **1問 = 1タブ**で N タブを v2 束縛で開く。
 * 旧来の単一 markdown は 1 タブ (v1) で従来どおり。問題本文は ProblemPanel に表示し、
 * リロード再表示用に ExamPackageStore へ (problemId キーで) 保存する。
 */
async function runExamUnlock(appCtx: AppContext): Promise<void> {
  const gate = new ExamStartGate();
  const { manifest, plaintext, packageHash, startToken } = await gate.prompt(); // 解錠まで block

  const decoded = decodeExamPlaintext(plaintext);
  if (decoded.kind === 'bundle') {
    await openBundleTabs(appCtx, manifest, packageHash, startToken, decoded.bundle.problems);
  } else {
    await openLegacyExamTab(appCtx, manifest, packageHash, startToken, decoded.statement);
  }
}

/** 旧来の単一問題 (v1): 1 タブ・root は packageHash + startToken のみ。 */
async function openLegacyExamTab(
  appCtx: AppContext,
  manifest: ExamPackageManifest,
  packageHash: string,
  startToken: string,
  statement: string
): Promise<void> {
  const language = manifest.allowed.languages[0] ?? 'c';
  const filename = `answer.${examFileExtension(language)}`;
  const problemContentHash = await computeProblemContentHash(statement);
  const examContext: ExamSessionContext = {
    examId: manifest.examId,
    problemId: manifest.problemId,
    variant: manifest.variant,
    packageHash,
    problemContentHash,
    startToken,
  };
  await appCtx.tabManager?.createTab(filename, language, '', { examContext });
  appCtx.problemPanel.setProblemText(statement);
  if (!appCtx.problemPanel.isVisible) appCtx.problemPanel.show();
  ExamPackageStore.save(manifest.problemId, { manifest, plaintext: statement });
}

/**
 * N問バンドル (v2): 各問を 1 タブで開く。先頭タブで humanAttestation を確定し、
 * 2 番目以降は共有して Turnstile を再実行しない (TemplateImporter と同じ発想)。
 * 各タブは per-problem hash で root v2 束縛し、starter があれば注入してイベント記録する。
 */
async function openBundleTabs(
  appCtx: AppContext,
  manifest: ExamPackageManifest,
  packageHash: string,
  startToken: string,
  problems: ExamBundleProblem[]
): Promise<void> {
  let sharedAttestation: HumanAttestationEventData | null = null;

  for (let i = 0; i < problems.length; i++) {
    const problem = problems[i]!;
    const language = problem.starter?.language ?? manifest.allowed.languages[0] ?? 'c';
    const filename = problem.starter?.filename ?? `${problem.problemId}.${examFileExtension(language)}`;
    const starterContent = problem.starter?.content ?? '';
    const problemContentHash = await computeBundleProblemHash(problem);

    const examContext: ExamSessionContext = {
      examId: manifest.examId,
      problemId: problem.problemId,
      variant: manifest.variant,
      packageHash,
      problemContentHash,
      startToken,
      rootBinding: 'v2',
    };

    const tab: TabState | null =
      (await appCtx.tabManager?.createTab(filename, language, starterContent, {
        examContext,
        ...(i > 0 && sharedAttestation ? { sharedAttestation } : {}),
      })) ?? null;

    if (i === 0 && tab) {
      sharedAttestation = tab.typingProof.getHumanAttestation();
    }

    // starter コードは「与えられた雛形 (タイプされていない)」なので注入イベントで明示し、
    // verifier の純タイピング判定が starter を異常としないようにする (テンプレート機能と同じ)。
    if (tab && starterContent.length > 0) {
      const contentHash = await computeHash(starterContent);
      await tab.typingProof.recordTemplateInjection({
        templateName: `${manifest.examId}/${problem.problemId}`,
        templateHash: problemContentHash,
        filename,
        content: starterContent,
        contentHash,
        contentLength: starterContent.length,
        totalFilesInTemplate: 1,
        injectionSource: 'file_import',
      });
    }

    ExamPackageStore.save(problem.problemId, { manifest, plaintext: problem.statement });
  }

  // 先頭タブをアクティブにし、その問題文を表示する。
  const first = appCtx.tabManager?.getAllTabs()[0];
  if (first) await appCtx.tabManager?.switchTab(first.id);
  appCtx.problemPanel.setProblemText(problems[0]?.statement ?? '');
  if (!appCtx.problemPanel.isVisible) appCtx.problemPanel.show();
}

/** リロード時: 復元タブの examContext に対応する問題本文を ExamPackageStore から再表示する。 */
function restoreExamProblemDisplay(appCtx: AppContext): void {
  const problemId = appCtx.tabManager?.getActiveTab()?.typingProof.examContext?.problemId;
  const pkg = problemId ? ExamPackageStore.get(problemId) : ExamPackageStore.getAny();
  if (!pkg) return;
  appCtx.problemPanel.setProblemText(pkg.plaintext);
  if (!appCtx.problemPanel.isVisible) appCtx.problemPanel.show();
}

/**
 * 授業モード初回入場 (ADR-0014): 非ブロッキングの問題ローダで平文 `.tcclass` を取り込み、
 * 各問を 1 タブで展開する。スキップ時 (resolve(null)) は何もしない (後段でウェルカム画面)。
 */
async function runClassLoad(appCtx: AppContext): Promise<void> {
  const loader = new ClassProblemLoader();
  const pkg = await loader.prompt();
  if (!pkg) return; // スキップ = 素のエディタで開始
  await openClassTabs(appCtx, pkg);
}

/**
 * 授業モード (ADR-0014): バンドル各問を 1 タブで開く (封印・root 束縛なし = casual genesis)。
 * exam の openBundleTabs と同じ `sharedAttestation` で先頭タブの #0 を共有し Turnstile storm を避ける。
 * starter は templateInjection で「与えられた雛形」として記録し、`templateName='tcclass/${problemId}'`
 * が **self-asserted problemId を proof に残す** (tier ①)。問題本文は ProblemPanel + ClassProblemStore。
 * タブは固定しない (tabLock なし) ので受講者は自由にタブを足せる。
 */
async function openClassTabs(appCtx: AppContext, pkg: ClassPackage): Promise<void> {
  const problems = pkg.bundle.problems;
  let sharedAttestation: HumanAttestationEventData | null = null;

  for (let i = 0; i < problems.length; i++) {
    const problem = problems[i]!;
    const language = problem.starter?.language ?? pkg.allowed.languages[0] ?? 'c';
    const filename = problem.starter?.filename ?? `${problem.problemId}.${examFileExtension(language)}`;
    const starterContent = problem.starter?.content ?? '';

    const tab: TabState | null =
      (await appCtx.tabManager?.createTab(filename, language, starterContent, {
        ...(i > 0 && sharedAttestation ? { sharedAttestation } : {}),
      })) ?? null;

    if (i === 0 && tab) {
      sharedAttestation = tab.typingProof.getHumanAttestation();
    }

    // starter は「タイプされていない雛形」なので注入イベントで明示する (純タイピング判定を汚さない)。
    // templateName に classId/problemId を入れて self-asserted ラベルを残す (tier ①)。
    if (tab && starterContent.length > 0) {
      const contentHash = await computeHash(starterContent);
      await tab.typingProof.recordTemplateInjection({
        templateName: `tcclass/${pkg.classId}/${problem.problemId}`,
        templateHash: contentHash,
        filename,
        content: starterContent,
        contentHash,
        contentLength: starterContent.length,
        totalFilesInTemplate: 1,
        injectionSource: 'file_import',
      });
    }

    ClassProblemStore.save(filename, { problemId: problem.problemId, statement: problem.statement });
  }

  // 先頭タブをアクティブにし、その問題文を表示する。
  const first = appCtx.tabManager?.getAllTabs()[0];
  if (first) await appCtx.tabManager?.switchTab(first.id);
  appCtx.problemPanel.setProblemText(problems[0]?.statement ?? '');
  if (!appCtx.problemPanel.isVisible) appCtx.problemPanel.show();
}

/** リロード時: 復元タブの filename に対応する問題本文を ClassProblemStore から再表示する。 */
function restoreClassProblemDisplay(appCtx: AppContext): void {
  const filename = appCtx.tabManager?.getActiveTab()?.filename;
  const problem = filename ? ClassProblemStore.get(filename) : ClassProblemStore.getAny();
  if (!problem) return;
  appCtx.problemPanel.setProblemText(problem.statement);
  if (!appCtx.problemPanel.isVisible) appCtx.problemPanel.show();
}

// ========================================
// メイン初期化関数
// ========================================

async function initializeApp(): Promise<void> {
  // Phase 0: 複数インスタンスの検出
  const instanceGuard = new SingleInstanceGuard();
  const hasExistingInstance = await instanceGuard.checkForExistingInstance();

  if (hasExistingInstance) {
    // 別のタブですでに起動中 - このタブをブロック
    console.log('[TypedCode] Another instance is already running, blocking this tab');
    initOverlay?.classList.add('hidden');
    showDuplicateInstanceOverlay();

    // 「このタブを閉じる」ボタンのイベントリスナー
    const closeBtn = document.getElementById('duplicate-instance-close-btn');
    closeBtn?.addEventListener('click', () => {
      window.close();
      // window.close() が効かない場合（ユーザーが開いたタブの場合）は空白ページに
      // リダイレクト
      window.location.href = 'about:blank';
    });

    return; // 初期化を中止
  }

  // Phase 0.5: 未対応ブラウザの検出（Safari等）
  // Safari/WebKitベースブラウザはScreen Capture APIのサポートが不十分なためブロック
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

  if (isSafari || isWebKit) {
    console.log('[TypedCode] Unsupported browser detected (Safari/WebKit), blocking');
    initOverlay?.classList.add('hidden');
    showUnsupportedBrowserOverlay();
    return; // 初期化を中止
  }

  // Phase 1: 利用規約の確認
  if (!hasAcceptedTerms()) {
    initOverlay?.classList.add('hidden');
    await showTermsModal();
    initOverlay?.classList.remove('hidden');
    updateInitMessage(t('app.initializing'));
  }

  // Phase 1.5: Screen Capture許可の取得（画面全体のみ許可）
  // セッション復旧の可能性を事前にチェック（IndexedDBにセッションが存在する場合、またはリロードの場合）
  const sessionService = await initSessionStorageService();
  const isReload = sessionStorage.getItem(sessionActiveKey()) === 'true';
  const hasExistingSession = await sessionService.hasExistingSession();

  if (!ctx.capabilities.screenshots) {
    // このモードでは画面キャプチャを使わない (課題モード = 自宅・プライバシー。ADR-0011)。
    // 画面共有の選択ダイアログも出さず、screenshot tracker を作らない。
    console.log('[TypedCode] Screenshots disabled for mode:', ctx.mode);
  } else if (ScreenshotTracker.isSupported()) {
    // ScreenshotTrackerはSessionStorageServiceを使用してスクリーンショットを保存
    const screenshotTracker = new ScreenshotTracker(sessionService);

    // 選択ダイアログを表示：「画面共有を開始」または「画面共有なしで使用」
    initOverlay?.classList.add('hidden');
    const choice = await showScreenShareChoiceDialog();
    initOverlay?.classList.remove('hidden');
    updateInitMessage(t('app.initializing'));

    // onContinueWithout コールバック: 画面共有なしで継続（オプトアウトに切り替え）
    const onContinueWithout = async (): Promise<boolean> => {
      const tracker = ctx.trackers.screenshot;
      if (tracker) {
        // ロックオーバーレイを一時的に非表示にして確認ダイアログを表示
        hideScreenCaptureLockOverlay();
        const confirmed = await showScreenShareOptOutConfirmDialog();
        if (confirmed) {
          tracker.setOptedOut(true);
          tracker.emitScreenShareOptOutEvent();
          showScreenShareOptOutBanner(onResume);
          return true; // オーバーレイは既に非表示
        } else {
          // キャンセルされた場合はロックオーバーレイを再表示
          showScreenCaptureLockOverlay(onResume, onContinueWithout);
          return false;
        }
      }
      return false; // オーバーレイを閉じない
    };

    // onResume コールバック: 画面共有を再開（または初めて有効化）
    const onResume = async (): Promise<boolean> => {
      const tracker = ctx.trackers.screenshot;
      if (tracker) {
        const success = await requestScreenCaptureWithRetry(tracker);
        if (success) {
          // オプトアウトから画面共有に切り替え成功
          tracker.setOptedOut(false);
          hideScreenShareOptOutBanner();
          // ストリーム停止時のコールバックを設定（重要：再開後もストリーム停止を検知）
          tracker.setStreamStoppedCallback(() => {
            showScreenCaptureLockOverlay(onResume, onContinueWithout);
          });
        }
        return success;
      }
      return false;
    };

    if (choice === 'cancelled') {
      // キャンセルされた場合は画面共有を要求（従来の動作）
      const permissionGranted = await requestScreenCaptureWithRetry(screenshotTracker, updateInitMessage);
      if (!permissionGranted) {
        showScreenCaptureLockOverlay(onResume, onContinueWithout);
        return;
      }
      // ストリーム停止時のコールバックを設定
      screenshotTracker.setStreamStoppedCallback(() => {
        showScreenCaptureLockOverlay(onResume, onContinueWithout);
      });
    } else if (choice === 'optOut') {
      // オプトアウトの確認ダイアログを表示
      initOverlay?.classList.add('hidden');
      const confirmed = await showScreenShareOptOutConfirmDialog();
      initOverlay?.classList.remove('hidden');
      updateInitMessage(t('app.initializing'));

      if (!confirmed) {
        // キャンセルされた場合は画面共有を要求
        const permissionGranted = await requestScreenCaptureWithRetry(screenshotTracker, updateInitMessage);
        if (!permissionGranted) {
          showScreenCaptureLockOverlay(onResume, onContinueWithout);
          return;
        }
        // ストリーム停止時のコールバックを設定
        screenshotTracker.setStreamStoppedCallback(() => {
          showScreenCaptureLockOverlay(onResume, onContinueWithout);
        });
      } else {
        // オプトアウト確定
        screenshotTracker.setOptedOut(true);
        // 注: オプトアウトイベントはTrackersInitializer後にコールバックが設定されてから発火される
        // バナーを表示（途中から画面共有を有効にするボタン付き）
        showScreenShareOptOutBanner(onResume);
        console.log('[TypedCode] Screen sharing opted out');
      }
    } else {
      // 「画面共有を開始」を選択
      const permissionGranted = await requestScreenCaptureWithRetry(screenshotTracker, updateInitMessage);
      if (!permissionGranted) {
        showScreenCaptureLockOverlay(onResume, onContinueWithout);
        return;
      }
      // ストリーム停止時のコールバックを設定
      screenshotTracker.setStreamStoppedCallback(() => {
        showScreenCaptureLockOverlay(onResume, onContinueWithout);
      });
    }

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

  // Phase 2.5: セッション復旧チェック
  // sessionServiceは Phase 1.5 で初期化済み
  // isReload, hasExistingSession も Phase 1.5 で取得済み
  updateInitMessage(t('app.initializing'));
  let sessionRecovered = false;
  let sessionId: string | null = null;

  // フラグをクリア（次回のためにリセット）
  sessionStorage.removeItem(sessionActiveKey());

  if (hasExistingSession) {
    const sessionSummary = await sessionService.getSessionSummary();

    if (sessionSummary && sessionSummary.tabs.length > 0) {
      if (isReload) {
        // リロード - sessionStorageから復元（IndexedDBより確実に最新）
        // sessionRecoveredをfalseのままにしてsessionStorageから読み込む
        const session = await sessionService.resumeSession(sessionSummary.sessionId);
        sessionId = session.sessionId;
        // sessionRecovered = false のままで、initializeTabManager()を使う
        console.log('[TypedCode] Session will be restored from sessionStorage (reload):', sessionId);
      } else {
        // タブを閉じた後の再開 - ダイアログを表示
        initOverlay?.classList.add('hidden');
        const result = await showSessionRecoveryDialog(sessionSummary);
        initOverlay?.classList.remove('hidden');
        updateInitMessage(t('app.initializing'));

        if (result.choice === 'resume') {
          // セッションを再開
          const session = await sessionService.resumeSession(sessionSummary.sessionId);
          sessionId = session.sessionId;
          sessionRecovered = true;
          console.log('[TypedCode] Session recovered:', sessionId);
        } else {
          // 新規セッションを開始 - sessionService.clearSession()で古いスクリーンショットも削除される
          await sessionService.clearSession();
          const newSession = await sessionService.createSession();
          sessionId = newSession.sessionId;
          console.log('[TypedCode] Fresh session started:', sessionId);
        }
      }
    } else {
      // タブがない場合は自動的に新規セッション - sessionService.clearSession()でスクリーンショットも削除
      await sessionService.clearSession();
      const newSession = await sessionService.createSession();
      sessionId = newSession.sessionId;
    }
  } else {
    // 既存セッションなし - 新規セッション作成
    const newSession = await sessionService.createSession();
    sessionId = newSession.sessionId;
    console.log('[TypedCode] New session created:', sessionId);
  }

  // ScreenshotTrackerにセッションIDを設定
  if (ctx.trackers.screenshot && sessionId) {
    ctx.trackers.screenshot.setSessionId(sessionId);
  }

  // Phase 3: デバイス情報取得
  const { fingerprintHash, fingerprintComponents } = await initializeDeviceInfo();

  // Phase 4: TabManager初期化
  let initialized: boolean;
  if (sessionRecovered && sessionId) {
    // セッション復旧モード: IndexedDBからタブを読み込む
    ctx.tabManager = new TabManager(ctx.editor);

    const editorTabsContainer = document.getElementById('editor-tabs');
    if (editorTabsContainer) {
      ctx.tabUIController = new TabUIController({
        container: editorTabsContainer,
        tabManager: ctx.tabManager,
        basePath: import.meta.env.BASE_URL,
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
      handleTabChange(ctx, tab);

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

    // IndexedDBからタブを読み込む
    updateInitMessage(t('sessionRecovery.resuming'));
    initialized = await ctx.tabManager.loadFromIndexedDB(sessionId, fingerprintHash, fingerprintComponents);
  } else {
    // 通常モード: sessionStorageから読み込み or 新規作成
    initialized = await initializeTabManager(fingerprintHash, fingerprintComponents);
  }

  if (!initialized) {
    updateInitMessage(t('notifications.authFailedReload'));
    showNotification(t('notifications.authFailedReload'));
    return;
  }

  hideInitOverlay();

  // 試験モード (ADR-0006): 初回入場 (タブ無し) は解錠ゲートで封印問題を開封してから
  // exam タブを 1 つ生成する (1問1タブ, ADR-0010)。genesis = 監督コード入力の瞬間。
  // リロード時は復元済みタブ (examContext 付き) があるので、問題本文だけ再表示する。
  if (ctx.examMode) {
    if (!ctx.tabManager?.hasAnyTabs()) {
      await runExamUnlock(ctx);
    } else {
      restoreExamProblemDisplay(ctx);
    }
  } else if (ctx.mode === 'class') {
    // 授業モード (ADR-0014): 初回入場は非ブロッキングの問題ローダで平文 `.tcclass` を取り込み、
    // 各問を 1 タブで展開する (封印なし・root 束縛なし)。スキップ可 (素のエディタになる)。
    // リロード時は復元済みタブの filename に対応する問題本文を再表示する。
    if (!ctx.tabManager?.hasAnyTabs()) {
      await runClassLoad(ctx);
    } else {
      restoreClassProblemDisplay(ctx);
    }
  }

  // タブがない場合はウェルカム画面を表示、ある場合は通常のエディタ表示
  if (!ctx.tabManager?.hasAnyTabs()) {
    showWelcomeScreen(ctx);
    // スクリーンショットのキャプチャを無効化（タブがないので保存先がない）
    ctx.trackers.screenshot?.setCaptureEnabled(false);
  } else {
    ctx.tabUIController?.updateUI();

    // 言語セレクタを更新
    const activeTab = ctx.tabManager?.getActiveTab();
    const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
    if (activeTab && languageSelector) {
      languageSelector.value = activeTab.language;
    }

    updateProofStatus(ctx);

    // 利用規約同意をハッシュチェーンに記録
    recordTermsAcceptance();
  }

  // タブ固定モード (試験): 初期問題タブ確定後、タブの追加・削除を源流でロックする (ADR-0010/0011)。
  if (ctx.capabilities.tabLock) {
    ctx.tabManager?.setExamLock(true);
  }

  // 全タブ閉じた時にウェルカム画面を表示するコールバックを設定
  ctx.tabManager?.setOnAllTabsClosed(() => {
    showWelcomeScreen(ctx);
    ctx.tabUIController?.updateUI();
    // ステータスバーをリセット
    ctx.proofStatusDisplay.reset();
    // スクリーンショットのキャプチャを無効化（タブがないので保存先がない）
    ctx.trackers.screenshot?.setCaptureEnabled(false);
    // 既存のスクリーンショットを全て削除
    ctx.trackers.screenshot?.clearStorage().catch((err) => {
      console.error('[TypedCode] Failed to clear screenshots:', err);
    });
  });

  // Phase 5: トラッカーの初期化
  initializeTrackers({
    ctx,
    editorContainer: editorContainer!,
    recordEvent: (event) => ctx.eventRecorder?.record(event),
    recordEventToAllTabs: (event) => ctx.eventRecorder?.recordToAllTabs(event) ?? Promise.resolve(),
    onProofStatusUpdate: () => updateProofStatus(ctx),
    onStorageSave: () => ctx.tabManager?.saveToStorage(),
    onFocusRegained: () => {
      // フォーカス復帰時にLogViewerを更新（フォーカス喪失中に記録されたイベントを反映）
      // focusChangeイベントの記録完了後に呼ばれるので、即座にrefresh可能
      console.debug(`[main] onFocusRegained: logViewer=${ctx.logViewer ? 'set' : 'null'}, isVisible=${ctx.logViewer?.isVisible}`);
      if (ctx.logViewer?.isVisible) {
        console.debug('[main] Refreshing LogViewer');
        ctx.logViewer.refreshLogs();
      }
    },
  });

  // Phase 5.5: 画面共有オプトアウトイベントの発火（コールバック設定後）
  // オプトアウトを選択した場合、ここでイベントを発火する
  if (ctx.trackers.screenshot?.isOptedOut()) {
    ctx.trackers.screenshot.emitScreenShareOptOutEvent();
  }

  // Phase 6: LogViewerとEventRecorderの初期化
  initializeLogViewer(ctx);
  initializeEventRecorder();

  // フルスクリーン追跡 (ADR-0008/0014、能力 fullscreenTracking)。eventRecorder 準備後に配線する。
  // exam は警告バナー + 要求ボタン (fullscreenBanner=true、ボタンが開始ジェスチャ)。
  // class は受動記録のみ (fullscreenBanner=false、状態は記録するがバナーは出さない)。
  if (ctx.capabilities.fullscreenTracking) {
    ctx.fullscreenTracker.setRecordCallback((event) => {
      void ctx.eventRecorder?.recordToAllTabs(event);
    });
    ctx.fullscreenTracker.initialize(ctx.capabilities.fullscreenBanner);
  }

  // Phase 7: ターミナルとコード実行の初期化
  initializeTerminal();
  initializeCodeExecution();

  // Phase 8: セッション再開イベントの記録（リロード時またはIndexedDBからの復旧時）
  // リロード検出は Phase 1.5 で取得済みの isReload (sessionActiveKey 由来、beforeunload で
  // 'true' を立てる) を使う。タブデータが sessionStorage に残っていればリロードによる再開。
  // (旧実装は未 set の screenshot-session フラグを見ていて常に false だった — ADR-0011 後の修正)
  const wasReloaded = isReload && sessionStorage.getItem(tabsKey()) !== null;
  if (wasReloaded || sessionRecovered) {
    // セッション再開イベントを全タブに記録
    ctx.eventRecorder?.recordToAllTabs({
      type: 'sessionResumed',
      data: {
        timestamp: performance.now(),
        previousEventCount: ctx.tabManager?.getActiveProof()?.events.length ?? 0,
        recoveredFromIndexedDB: sessionRecovered,
      },
      description: t('events.sessionResumed'),
    });
    console.log('[TypedCode] Session resumed', sessionRecovered ? 'from IndexedDB' : 'after reload');
  }

  // Phase 9: タイトルバー時計の開始
  ctx.titlebarClock.start();

  // Phase 10: IdleTimeoutManagerの初期化
  initializeIdleTimeoutManager();

  console.log('[TypedCode] App initialized successfully');
}

// DOMContentLoaded または即座に実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    // 静的イベントリスナーを設定（DOM準備後）
    setupStaticEventListeners(ctx);
    void initializeApp();
  });
} else {
  // 静的イベントリスナーを設定（DOM準備後）
  setupStaticEventListeners(ctx);
  void initializeApp();
}

// エディタインスタンスをエクスポート（拡張用）
export { editor, monaco };
