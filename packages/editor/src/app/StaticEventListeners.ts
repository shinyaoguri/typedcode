/**
 * StaticEventListeners - 静的イベントリスナーの設定
 * DOM要素への各種イベントリスナーを設定
 */

import type { AppContext } from '../core/AppContext.js';
import type { CursorPosition, RecordEventInput, DetectedEvent } from '@typedcode/shared';
import { InputDetector } from '../tracking/InputDetector.js';
import { isTurnstileConfigured } from '../services/TurnstileService.js';
import { clearStorageSync, deleteScreenshotsDB } from '../utils/StorageClearHelper.js';
import { t } from '../i18n/index.js';
import { showNotification } from './AppHelpers.js';
import { handleTemplateImport, handleTemplateDrop, isTemplateFile } from './TemplateHandler.js';
import { showLanguageDescriptionInTerminal } from './TerminalHandler.js';

/**
 * 静的イベントリスナーを設定
 */
export function setupStaticEventListeners(ctx: AppContext): void {
  // テンプレートファイルのドラッグ＆ドロップ
  const editorArea = document.querySelector('.workbench');
  let dropOverlay: HTMLElement | null = null;
  let dragCounter = 0; // ネストしたdragenter/dragleaveを正しく処理するためのカウンター

  // ドロップオーバーレイを作成
  const createDropOverlay = (): HTMLElement => {
    const overlay = document.createElement('div');
    overlay.className = 'template-drop-overlay';
    overlay.innerHTML = `
      <div class="template-drop-content">
        <i class="fas fa-file-import"></i>
        <h3>${t('template.dropTitle') ?? 'テンプレートをドロップ'}</h3>
        <p>${t('template.dropHint') ?? 'YAMLファイルをここにドロップして読み込み'}</p>
      </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
  };

  // オーバーレイを表示
  const showDropOverlay = (): void => {
    if (!dropOverlay) {
      dropOverlay = createDropOverlay();
    }
    dropOverlay.classList.remove('hidden');
  };

  // オーバーレイを非表示
  const hideDropOverlay = (): void => {
    dropOverlay?.classList.add('hidden');
  };

  if (editorArea) {
    // ドラッグ開始時（ウィンドウ全体で検知）
    document.addEventListener('dragenter', (e) => {
      const event = e as DragEvent;
      const items = event.dataTransfer?.items;

      // ファイルがドラッグされている場合のみ
      if (items && items.length > 0) {
        for (const item of Array.from(items)) {
          if (item.kind === 'file') {
            dragCounter++;
            if (dragCounter === 1) {
              showDropOverlay();
            }
            break;
          }
        }
      }
    });

    // ドラッグ終了時（ウィンドウから離れた時）
    document.addEventListener('dragleave', (e) => {
      const event = e as DragEvent;
      // ウィンドウ外に出た場合のみカウンターを減らす
      if (event.relatedTarget === null || !(event.relatedTarget instanceof Node)) {
        dragCounter--;
        if (dragCounter <= 0) {
          dragCounter = 0;
          hideDropOverlay();
        }
      }
    });

    // ドラッグオーバー時のデフォルト動作を防止（ドロップを許可）
    editorArea.addEventListener('dragover', (e) => {
      const event = e as DragEvent;
      // ファイルがドラッグされている場合のみドロップを許可
      const items = event.dataTransfer?.items;
      if (items && items.length > 0) {
        for (const item of Array.from(items)) {
          if (item.kind === 'file') {
            event.preventDefault();
            event.dataTransfer!.dropEffect = 'copy';
            break;
          }
        }
      }
    });

    // ドロップ時の処理
    editorArea.addEventListener('drop', async (e) => {
      const event = e as DragEvent;
      const files = event.dataTransfer?.files;

      // オーバーレイを非表示
      dragCounter = 0;
      hideDropOverlay();

      if (files && files.length > 0) {
        const file = files[0]!;
        // テンプレートファイルかチェック
        if (isTemplateFile(file)) {
          event.preventDefault();
          event.stopPropagation();

          try {
            await handleTemplateDrop(ctx, file);
          } catch (error) {
            console.error('[TemplateImport] Drop error:', error);
            showNotification(t('template.error'));
          }
        }
        // テンプレートファイル以外はデフォルト動作（InputDetectorでexternalInput検出）
      }
    });

    // ドロップがキャンセルされた場合（ESCキーなど）
    document.addEventListener('drop', () => {
      dragCounter = 0;
      hideDropOverlay();
    });
  }

  // 言語切り替え
  const languageSelector = document.getElementById('language-selector') as HTMLSelectElement | null;
  languageSelector?.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    const activeTab = ctx.tabManager?.getActiveTab();
    if (activeTab) {
      ctx.tabManager?.setTabLanguage(activeTab.id, target.value);
      ctx.tabUIController?.updateUI();
      showLanguageDescriptionInTerminal(ctx, target.value);
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
    console.log('[TypedCode] Detected operation:', detectedEvent);

    if (detectedEvent.type === 'paste') {
      const position: CursorPosition | null = ctx.editor.getPosition();
      const pastedText = detectedEvent.data.text;

      // 内部コンテンツかどうかをチェック
      const isInternal = ctx.contentRegistry.isInternalContent(pastedText);

      if (isInternal) {
        // 内部ペースト - 許可される
        showNotification(t('notifications.internalPasteDetected', { length: detectedEvent.data.length }));

        if (position) {
          const event: RecordEventInput = {
            type: 'contentChange',
            inputType: 'insertFromInternalPaste',
            data: pastedText,
            rangeLength: detectedEvent.data.length,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
            description: t('notifications.internalPasteDetected', { length: detectedEvent.data.length }),
          };

          ctx.eventRecorder?.record(event);
        }
      } else {
        // 外部ペースト - 禁止される
        showNotification(detectedEvent.message);

        if (position) {
          const event: RecordEventInput = {
            type: 'externalInput',
            inputType: 'insertFromPaste',
            data: pastedText,
            rangeLength: detectedEvent.data.length,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
            description: t('notifications.pasteDetected', { length: detectedEvent.data.length }),
          };

          ctx.eventRecorder?.record(event);
        }
      }
    } else if (detectedEvent.type === 'drop') {
      // ドロップは常に外部入力として扱う
      showNotification(detectedEvent.message);

      const position: CursorPosition | null = ctx.editor.getPosition();
      if (position) {
        const event: RecordEventInput = {
          type: 'externalInput',
          inputType: 'insertFromDrop',
          data: detectedEvent.data.text,
          rangeLength: detectedEvent.data.length,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          description: t('notifications.dropDetected', { length: detectedEvent.data.length }),
        };

        ctx.eventRecorder?.record(event);
      }
    } else if (detectedEvent.type === 'copy') {
      // コピーされたコンテンツをレジストリに登録（内部ペースト判定用）
      ctx.contentRegistry.registerCopiedContent(detectedEvent.data.text);

      // コピーイベントを記録（監査用）
      const position: CursorPosition | null = ctx.editor.getPosition();
      if (position) {
        const event: RecordEventInput = {
          type: 'copyOperation',
          data: detectedEvent.data.text,
          rangeLength: detectedEvent.data.length,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          description: t('notifications.copyDetected', { length: detectedEvent.data.length }),
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

    // ストレージをクリア（同期版）
    clearStorageSync();

    // リロード（reset パラメータ付き）
    window.location.href = window.location.origin + window.location.pathname + '?reset=' + Date.now();
  });

  // ページ離脱時の確認ダイアログ
  // セッションの非アクティブ化は visibilitychange + document.hidden で行う
  window.addEventListener('beforeunload', (e) => {
    if (ctx.skipBeforeUnload) return;

    // スクリーンショットのIndexedDBを削除（sessionStorageと同様にタブを閉じたら消える）
    deleteScreenshotsDB();

    // セッションをアクティブとしてマーク（リロード検出用）
    // sessionStorageはリロード時は保持され、タブを閉じると消える
    // 次回起動時にこのフラグがあればリロード、なければタブを閉じた後の再開
    try {
      sessionStorage.setItem('typedcode-session-active', 'true');
    } catch {
      // ignore
    }

    const activeProof = ctx.tabManager?.getActiveProof();
    if (activeProof && activeProof.events.length > 0) {
      e.preventDefault();
    }
  });

  // 現在のタブをZIPでエクスポート（ファイル + 検証ログ）
  const exportCurrentTabBtn = document.getElementById('export-current-tab-btn');
  exportCurrentTabBtn?.addEventListener('click', (e) => {
    // 無効時は何もしない
    if ((e.currentTarget as HTMLElement).classList.contains('disabled')) return;
    ctx.downloadDropdown.close();
    void ctx.proofExporter.exportCurrentTab();
  });

  const exportZipBtn = document.getElementById('export-zip-btn');
  exportZipBtn?.addEventListener('click', (e) => {
    // 無効時は何もしない
    if ((e.currentTarget as HTMLElement).classList.contains('disabled')) return;
    ctx.downloadDropdown.close();
    void ctx.proofExporter.exportAllTabsAsZip();
  });
}
