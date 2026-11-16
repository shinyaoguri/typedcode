/**
 * Dialog a11y helper (#305)
 *
 * div で組んだダイアログに「支援技術・キーボード利用者が使える最低限」を付ける:
 * role / aria-modal / aria-labelledby、開いたときの初期フォーカス、Tab の閉じ込め、Escape、
 * 閉じたときの起点へのフォーカス復帰。document に付けるリスナーは `close()` で必ず解放する。
 *
 * ネイティブ `<dialog>` + `showModal()` は使わない: top layer に出るため、`ExamStartGate`
 * (z-index: 40000) など既存の重なり規則が変わる。
 *
 * このヘルパは DOM の生成・除去やアニメーションを持たない。閉じる処理 (overlay の除去、
 * Promise の解決) は呼び出し側が持ち、その中で `close()` を 1 回呼ぶ。`close()` は冪等。
 * `onRequestClose` は Escape を受けたときだけ呼ばれる (要求であって、閉じる義務は呼び出し側)。
 */

export interface DialogA11yOptions {
  /** ダイアログの名前になる要素。`aria-labelledby` の指し先で、id が無ければ振る */
  labelledBy: HTMLElement;
  /** 開いた直後にフォーカスする要素。省略時は最初のフォーカス可能な要素、無ければダイアログ自身 */
  initialFocus?: HTMLElement | null;
  /**
   * 閉じた後に戻すフォーカス先。省略時は開いた時点の `document.activeElement`。
   * 開く操作がメニュー項目のように「ダイアログを開くと同時に消える」要素のときに明示する
   * (消えかけの要素は focus() が一旦成功し、直後のフォーカス補正で body に落ちる)
   */
  returnFocusTo?: HTMLElement | null;
  /**
   * 戻し先に戻せないとき (DOM から消えた・フォーカスできない) のフォーカス先。
   * 関数なら閉じた時点で引く (開いている間に描き直されて要素が入れ替わる場合)
   */
  fallbackFocus?: HTMLElement | null | (() => HTMLElement | null);
  /** false なら Escape を無視する (閉じさせたくないダイアログ)。既定 true */
  closeOnEscape?: boolean;
  /** Escape を受けた (閉じてよい) とき */
  onRequestClose: () => void;
}

export interface DialogA11yHandle {
  /** リスナーを解放し、フォーカスを起点へ戻す。2 回目以降は何もしない */
  close(): void;
}

/**
 * Tab 巡回の対象。`display: none` などの描画状態までは見ない (`hidden` 属性と `inert` だけ除外する)。
 * `iframe` を含めるのは、書き出し中の Turnstile ウィジェット (cross-origin) にキーボードで入れるように。
 * iframe の中は keydown を受けられないので閉じ込めの外に出るが、次の Tab でここへ引き戻す
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'iframe',
  'summary', // <details> の開閉 (規約・起動失敗の詳細)。無いと Shift+Tab の折り返しが飛ばす
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** 開いている順のスタック。最前面のダイアログだけがキーを処理する */
const openDialogs: object[] = [];

let titleIdSeq = 0;

/**
 * 起点が `aria-controls` で制御される popup (メニュー) の中にあれば、その制御元 (メニューを開いたボタン)。
 * メニューは項目を押すと閉じるので、閉じた後に項目へは戻せない (WAI-ARIA のメニューボタンの型では
 * フォーカスはメニューボタンへ戻る)。無ければ null
 */
function popupControllerOf(el: Element): HTMLElement | null {
  for (let node: Element | null = el.parentElement; node; node = node.parentElement) {
    if (!node.id) continue;
    for (const controller of document.querySelectorAll<HTMLElement>('[aria-controls]')) {
      if (controller.getAttribute('aria-controls')?.split(/\s+/).includes(node.id) && !node.contains(controller)) {
        return controller;
      }
    }
  }
  return null;
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => !el.closest('[hidden], [inert]'));
}

export function attachDialogA11y(dialog: HTMLElement, options: DialogA11yOptions): DialogA11yHandle {
  const { labelledBy, initialFocus, returnFocusTo, fallbackFocus, closeOnEscape = true, onRequestClose } = options;

  const active = document.activeElement;
  const activeOpener = active instanceof HTMLElement && active !== document.body ? active : null;
  const opener = returnFocusTo ?? (activeOpener ? (popupControllerOf(activeOpener) ?? activeOpener) : null);

  if (!labelledBy.id) {
    labelledBy.id = `dialog-title-${++titleIdSeq}`;
  }
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', labelledBy.id);
  if (!dialog.hasAttribute('tabindex')) {
    dialog.tabIndex = -1; // フォーカス可能な子が無いときの受け皿
  }

  const entry = {};

  const trapTab = (e: KeyboardEvent): void => {
    const focusable = getFocusable(dialog);
    if (focusable.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const current = document.activeElement;
    const inside = current instanceof Node && dialog.contains(current);
    if (e.shiftKey) {
      if (!inside || current === first || current === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || current === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (openDialogs[openDialogs.length - 1] !== entry) return;
    if (e.key === 'Escape') {
      if (closeOnEscape) {
        e.preventDefault();
        onRequestClose();
      }
    } else if (e.key === 'Tab') {
      trapTab(e);
    }
  };

  document.addEventListener('keydown', onKeyDown);
  openDialogs.push(entry);

  (initialFocus ?? getFocusable(dialog)[0] ?? dialog).focus();

  let released = false;

  const restoreFocus = (): void => {
    const fallback = typeof fallbackFocus === 'function' ? fallbackFocus() : fallbackFocus;
    for (const target of [opener, fallback]) {
      if (target?.isConnected) {
        target.focus();
        if (document.activeElement === target) return;
      }
    }
    // 戻せる先が無い。除去されるダイアログ内にフォーカスを残さない
    if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  };

  return {
    close(): void {
      if (released) return;
      released = true;
      document.removeEventListener('keydown', onKeyDown);
      const index = openDialogs.indexOf(entry);
      if (index !== -1) openDialogs.splice(index, 1);
      restoreFocus();
    },
  };
}

export interface StaticDialogOptions extends Omit<DialogA11yOptions, 'labelledBy' | 'onRequestClose'> {
  /** 名前になる要素。省略時は `.modal-header h3` */
  labelledBy?: HTMLElement;
  /** Escape を受けたとき。`closeOnEscape: false` なら省略してよい */
  onRequestClose?: () => void;
}

/**
 * `index.html` に置いてある静的な overlay (`.modal-overlay.hidden` > `.modal-dialog`) を開く。
 * `.hidden` を外して中の `.modal-dialog` に `attachDialogA11y` を付ける。返す `close()` は冪等で、
 * リスナーを解放してフォーカスを戻し、`.hidden` を付け直す (閉じる経路はすべてこれを通す)。
 */
export function showStaticDialog(overlay: HTMLElement, options: StaticDialogOptions = {}): DialogA11yHandle {
  const dialog = overlay.querySelector<HTMLElement>('.modal-dialog') ?? overlay;
  const { labelledBy, onRequestClose, ...rest } = options;
  overlay.classList.remove('hidden');
  const a11y = attachDialogA11y(dialog, {
    ...rest,
    labelledBy: labelledBy ?? dialog.querySelector<HTMLElement>('.modal-header h3') ?? dialog,
    onRequestClose: onRequestClose ?? (() => undefined),
  });
  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      a11y.close();
      overlay.classList.add('hidden');
    },
  };
}
