/**
 * RuntimeManager - 言語ランタイムの状態管理
 * 各言語の実行環境の初期化状態、説明文、インジケーター更新を管理
 */

import { getCExecutor } from '../executors/c/CExecutor.js';
import type { InitializationProgress } from '../executors/interfaces/ILanguageExecutor.js';
import {
  SUPPORTED_LANGUAGES,
  type LanguageId,
} from '../config/SupportedLanguages.js';
import { t } from '../i18n/index.js';

/** ランタイム状態 */
export type RuntimeState = 'not-ready' | 'loading' | 'ready';

/** 共通の注意書き */
const EXECUTION_DISCLAIMER =
  '※ ブラウザ上の簡易実行環境です。ローカル環境と動作が異なる場合があります。';

/** ブラウザ内蔵で常にreadyな言語 */
const BROWSER_NATIVE_LANGUAGES: LanguageId[] = ['javascript', 'typescript'];

export interface RuntimeManagerCallbacks {
  onStatusChange?: (language: string, state: RuntimeState) => void;
}

/**
 * 実行可能な言語の初期ステータスを生成
 */
function createInitialStatus(): Record<string, RuntimeState> {
  const status: Record<string, RuntimeState> = {};
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.executable) {
      status[lang.id] = BROWSER_NATIVE_LANGUAGES.includes(lang.id) ? 'ready' : 'not-ready';
    }
  }
  return status;
}

/**
 * 実行可能な言語のランタイム表示名を生成
 */
function createDisplayNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.executable && lang.runtimeName) {
      names[lang.id] = lang.runtimeName;
    }
  }
  return names;
}

export class RuntimeManager {
  private status: Record<string, RuntimeState> = createInitialStatus();

  private displayNames: Record<string, string> = createDisplayNames();

  private callbacks: RuntimeManagerCallbacks = {};

  /**
   * コールバックを設定
   */
  setCallbacks(callbacks: RuntimeManagerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 言語のランタイム状態を取得
   */
  getStatus(language: string): RuntimeState {
    return this.status[language] || 'not-ready';
  }

  /**
   * 言語のランタイム状態を設定
   */
  setStatus(language: string, state: RuntimeState): void {
    this.status[language] = state;

    // C++はCと同じランタイム（Clang）を共有
    if (language === 'c') {
      this.status['cpp'] = state;
    }

    this.callbacks.onStatusChange?.(language, state);
  }

  /**
   * 言語の表示名を取得
   */
  getDisplayName(language: string): string {
    return this.displayNames[language] || '';
  }

  /**
   * 言語ごとのターミナル説明を取得
   */
  getLanguageDescription(language: string): string[] {
    switch (language) {
      case 'c':
        return t('terminal.cRuntime').split('\n');
      case 'cpp':
        return t('terminal.cppRuntime').split('\n');
      case 'javascript':
        return t('terminal.jsRuntime').split('\n');
      case 'typescript':
        return t('terminal.tsRuntime').split('\n');
      case 'python':
        return t('terminal.pythonRuntime').split('\n');
      case 'html':
      case 'css':
      case 'plaintext':
        return t('terminal.notAvailable').split('\n');
      default:
        return [
          t('terminal.title'),
          t('terminal.runHint'),
          EXECUTION_DISCLAIMER,
        ];
    }
  }

  /**
   * 言語セレクタ横のランタイムインジケーターを更新
   */
  updateIndicator(language: string): void {
    const indicator = document.getElementById('runtime-state-indicator');
    if (!indicator) return;

    const state = this.getStatus(language);
    const displayName = this.getDisplayName(language);

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
      loading: `${displayName} Loading...`,
      ready: `${displayName} ✓`,
    };
    indicator.textContent = stateText[state];
  }

  /**
   * C言語実行環境をバックグラウンドで初期化
   * エディタの操作をブロックせずに非同期でダウンロード
   */
  async initializeCRuntime(): Promise<void> {
    // 既にreadyなら何もしない
    if (this.status['c'] === 'ready') {
      console.log('[RuntimeManager] C runtime already initialized');
      return;
    }

    // loadingなら既に初期化中
    if (this.status['c'] === 'loading') {
      console.log('[RuntimeManager] C runtime initialization already in progress');
      return;
    }

    console.log('[RuntimeManager] Starting background C runtime initialization...');
    this.setStatus('c', 'loading');

    try {
      const executor = getCExecutor();
      await executor.initialize((progress: InitializationProgress) => {
        console.log('[RuntimeManager] C runtime:', progress.message);
      });

      this.setStatus('c', 'ready');
      console.log('[RuntimeManager] C runtime initialization complete');
    } catch (error) {
      console.error('[RuntimeManager] C runtime initialization failed:', error);
      // 失敗時は not-ready に戻す
      this.setStatus('c', 'not-ready');
    }
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.callbacks = {};
  }
}
