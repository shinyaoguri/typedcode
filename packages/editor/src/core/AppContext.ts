/**
 * AppContext - アプリケーションの状態を集約するコンテキスト
 *
 * main.ts のグローバル変数を1つのオブジェクトに集約し、
 * 各コンポーネント間の依存関係を明確にする。
 */

import type * as monaco from 'monaco-editor';
import type { TabManager } from '../ui/tabs/TabManager.js';
import type { TabUIController } from '../ui/tabs/TabUIController.js';
import type { LogViewer } from '../ui/components/LogViewer.js';
import type { ThemeManager } from '../editor/ThemeManager.js';
import type { CTerminal } from '../terminal/CTerminal.js';
import type { EventRecorder } from './EventRecorder.js';

// Trackers
import type { WindowTracker } from '../tracking/WindowTracker.js';
import type { VisibilityTracker } from '../tracking/VisibilityTracker.js';
import type { KeystrokeTracker } from '../tracking/KeystrokeTracker.js';
import type { MouseTracker } from '../tracking/MouseTracker.js';
import type { NetworkTracker } from '../tracking/NetworkTracker.js';
import type { CursorTracker } from '../editor/CursorTracker.js';
import type { OperationDetector } from '../tracking/OperationDetector.js';
import type { EditorController } from '../editor/EditorController.js';
import type { ScreenshotTracker } from '../tracking/ScreenshotTracker.js';

// UI Components
import type { ProcessingDialog } from '../ui/components/ProcessingDialog.js';
import type { ProofStatusDisplay } from '../ui/components/ProofStatusDisplay.js';
import type { SettingsDropdown } from '../ui/components/SettingsDropdown.js';
import type { DownloadDropdown } from '../ui/components/DownloadDropdown.js';
import type { MainMenuDropdown } from '../ui/components/MainMenuDropdown.js';
import type { TerminalPanel } from '../ui/components/TerminalPanel.js';
import type { BrowserPreviewPanel } from '../ui/components/BrowserPreviewPanel.js';
import type { WelcomeScreen } from '../ui/components/WelcomeScreen.js';

// Execution
import type { CodeExecutionController } from '../execution/CodeExecutionController.js';
import type { RuntimeManager } from '../execution/RuntimeManager.js';

// Export
import type { ProofExporter } from '../export/ProofExporter.js';

/**
 * トラッカー群の型定義
 */
export interface Trackers {
  window: WindowTracker;
  visibility: VisibilityTracker;
  keystroke: KeystrokeTracker;
  mouse: MouseTracker;
  network: NetworkTracker;
  cursor: CursorTracker;
  operation: OperationDetector;
  screenshot: ScreenshotTracker | null;  // 許可が得られない場合はnull
}

/**
 * アプリケーションコンテキストの型定義
 */
export interface AppContext {
  // Monaco Editor
  editor: monaco.editor.IStandaloneCodeEditor;
  themeManager: ThemeManager;

  // Tab Management
  tabManager: TabManager | null;
  tabUIController: TabUIController | null;

  // Logging
  logViewer: LogViewer | null;

  // Trackers
  trackers: Trackers;
  editorController: EditorController;

  // Terminal & Execution
  terminal: CTerminal | null;
  codeExecution: CodeExecutionController;
  runtime: RuntimeManager;

  // Recording
  eventRecorder: EventRecorder | null;
  proofExporter: ProofExporter;

  // UI Dialogs & Controls
  processingDialog: ProcessingDialog;
  proofStatusDisplay: ProofStatusDisplay;
  settingsDropdown: SettingsDropdown;
  downloadDropdown: DownloadDropdown;
  mainMenuDropdown: MainMenuDropdown;
  terminalPanel: TerminalPanel;
  browserPreviewPanel: BrowserPreviewPanel;

  // Flags
  skipBeforeUnload: boolean;

  // Welcome Screen
  welcomeScreen: WelcomeScreen | null;
}
