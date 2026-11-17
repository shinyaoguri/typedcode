/**
 * StaticEventListeners - 静的イベントリスナーの設定
 * DOM要素への各種イベントリスナーを設定
 */

import type { AppContext } from '../core/AppContext.js';
import type { CursorPosition, RecordEventInput, DetectedEvent } from '@typedcode/shared';
import { InputDetector } from '../tracking/InputDetector.js';
import { isTurnstileConfigured } from '../services/TurnstileService.js';
import { t } from '../i18n/index.js';
import { showNotification } from './AppHelpers.js';
import { handleBeforeUnload } from './beforeUnloadGuard.js';
import { setupResetDialog } from './resetDialog.js';
import { handleTemplateDrop, isTemplateFile } from './TemplateHandler.js';
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
        // テンプレートファイル以外は取り込まない。外部入力 (externalInput / insertFromDrop) としての記録は、
        // この要素に capture で付けた drop 用の InputDetector (下の「入力検出器の初期化」) が先に行っている
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
      // 試験の許可言語 (#727)。選択肢を隠しても値は直接書き換えられるので、変更の境界で判定する
      const requested = target.value;
      if (!ctx.tabManager?.setTabLanguage(activeTab.id, requested)) {
        target.value = activeTab.language;
        showNotification(t('notifications.languageNotAllowed', { language: requested }), 'language-not-allowed');
        return;
      }
      ctx.tabUIController?.updateUI();
      showLanguageDescriptionInTerminal(ctx, target.value);
      ctx.runtime.updateIndicator(target.value);
    }
  });

  // 新規タブ追加ボタン
  const addTabBtn = document.getElementById('add-tab-btn');
  addTabBtn?.addEventListener('click', async () => {
    if (ctx.capabilities.tabLock) return; // タブ固定モード (試験) では新規タブ不可 (ADR-0010/0011)
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

  // 入力検出器の初期化 (#697)
  const onDetected = async (detectedEvent: DetectedEvent) => {
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
  };

  // paste / copy は Monaco に渡したコンテナ (#editor。Monaco 以外は入らない) で拾う。target は Monaco の
  // 入力要素 (EditContext の div か textarea) でコンテナの子孫になる。document.body で拾うと、ターミナル
  // (xterm の textarea) やエディタ外のフォームへの貼り付けまでコードへの外部入力としてカーソル位置に
  // 記録してしまう (stdin は terminalInput の経路で別に記録される)
  new InputDetector(ctx.editor.getContainerDomNode(), onDetected, ['paste', 'copy']);
  // drop はファイルのドロップを受け付けている領域 (editorArea = .workbench。テンプレートの取込とオーバーレイの
  // 範囲) で拾う。検出漏れは証明の信頼性を下げるので、Monaco の外への drop も外部入力として残す。
  // 1 つの検出器だけが drop を聞くので、Monaco の中への drop も 1 回だけ記録される
  new InputDetector(editorArea instanceof HTMLElement ? editorArea : ctx.editor.getContainerDomNode(), onDetected, [
    'drop',
  ]);

  // リセット機能 (ダイアログの開閉・確定。a11y は resetDialog.ts)
  setupResetDialog(ctx);

  // ページ離脱時の確認ダイアログ
  // (セッションの isActive は書き換えない。リロードとタブ閉じの区別は下の sessionStorage フラグで行う)
  window.addEventListener('beforeunload', (e) => handleBeforeUnload(ctx, e));

  // bfcache から戻ったとき (モード移動・言語切替の後に履歴で戻った場合など) は、確認の抑止を解除して
  // 以後のタブ閉じでは確認が出るようにする
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) ctx.skipUnloadConfirm = false;
  });

  // 全タブの証明 ZIP を書き出す (書き出しは 1 系統・ボタン 1 つ。#779)。タブが無いときの通知は
  // exportAllTabsAsZip が出す
  document.getElementById('download-btn')?.addEventListener('click', () => {
    void ctx.proofExporter.exportAllTabsAsZip();
  });
}
