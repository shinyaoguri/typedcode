/**
 * Modal Component
 *
 * Provides functionality for showing and managing modal dialogs.
 */

import { attachDialogA11y } from './dialogA11y.js';

/**
 * 同じ id で出し直されたときに前の countdown / lock overlay の片付け (timer・keydown リスナーの解放) を
 * 呼ぶための表 (#305)。DOM から外すだけだと、前の回の interval とフォーカスの閉じ込めが残る
 */
const overlayDisposers = new Map<string, () => void>();

export interface ModalButton {
  /** Button text */
  text: string;
  /** Button type for styling */
  type: 'primary' | 'cancel' | 'danger';
  /** Click handler - if returns true, modal closes */
  onClick?: () => boolean | undefined | Promise<boolean | undefined>;
  /** Whether button is disabled */
  disabled?: boolean;
  /** Optional icon class (Font Awesome) */
  icon?: string;
  /** 状態契約の `data-action` に出す値 (E2E がボタンを翻訳テキストに依らず選ぶため) */
  action?: string;
}

export interface ModalOptions {
  /** Modal title */
  title: string;
  /** Modal body content (HTML string or text) */
  content: string;
  /** Modal style variant */
  variant?: 'default' | 'danger' | 'info' | 'terms';
  /** Header icon class (Font Awesome) */
  icon?: string;
  /** Footer buttons */
  buttons?: ModalButton[];
  /** Whether clicking overlay closes the modal */
  closeOnOverlayClick?: boolean;
  /**
   * Whether the Escape key closes the modal.
   * Defaults to `closeOnOverlayClick`: a modal that must not be dismissed from outside
   * cannot be dismissed with Escape either.
   */
  closeOnEscape?: boolean;
  /** Custom CSS class for the modal dialog */
  className?: string;
  /**
   * 状態契約の `data-dialog` に出す名前 (packages/editor/AGENTS.md「状態契約」)。
   * overlay (開閉で `.hidden` が付く・DOM から外れる要素) に付ける。
   */
  dialogName?: string;
}

/** 初期フォーカスの置き場。破壊的な操作があるときは取り消しを優先する */
function pickInitialFocus(buttons: ModalButton[], elements: HTMLButtonElement[]): HTMLButtonElement | undefined {
  const enabled = elements.flatMap((el, i) => (buttons[i]?.disabled ? [] : [{ el, type: buttons[i]!.type }]));
  const find = (type: ModalButton['type']): HTMLButtonElement | undefined => enabled.find((b) => b.type === type)?.el;
  const hasDanger = enabled.some((b) => b.type === 'danger');
  return (hasDanger ? find('cancel') : undefined) ?? find('primary') ?? enabled[0]?.el;
}

/**
 * Show a modal dialog
 *
 * a11y (#305): role / aria-modal / aria-labelledby、初期フォーカス、Tab の閉じ込め、
 * 起点へのフォーカス復帰は `dialogA11y.ts` が担う。どの経路で閉じても同じ `closeModal` を通り、
 * document のリスナーはそこで解放される。
 *
 * @param options - Modal configuration
 * @returns Promise that resolves when modal is closed
 */
export async function showModal(options: ModalOptions): Promise<void> {
  const {
    title,
    content,
    variant = 'default',
    icon = 'fa-info-circle',
    buttons = [{ text: 'OK', type: 'primary' }],
    closeOnOverlayClick = true,
    closeOnEscape = closeOnOverlayClick,
    className,
    dialogName,
  } = options;

  return new Promise((resolve) => {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    if (dialogName) overlay.dataset.dialog = dialogName;

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = `modal-dialog modal-${variant}`;
    if (className) {
      dialog.classList.add(className);
    }

    // Build dialog HTML
    dialog.innerHTML = `
      <div class="modal-header">
        <i class="fas ${icon}" aria-hidden="true"></i>
        <h3>${title}</h3>
      </div>
      <div class="modal-body">
        ${content}
      </div>
      <div class="modal-footer"></div>
    `;

    // Add buttons
    const footer = dialog.querySelector('.modal-footer')!;
    const buttonEls: HTMLButtonElement[] = [];
    // onClick 実行中・閉じる処理中は、ボタン・Escape・overlay のどれからも新しい操作を受けない
    let busy = false;
    let closed = false;

    buttons.forEach((btn) => {
      const button = document.createElement('button');
      button.className = `modal-btn modal-btn-${btn.type}`;
      if (btn.action) button.dataset.action = btn.action;
      if (btn.disabled) {
        button.disabled = true;
      }
      button.innerHTML = btn.icon ? `<i class="fas ${btn.icon}" aria-hidden="true"></i> ${btn.text}` : btn.text;

      button.addEventListener('click', async () => {
        // 実行中は全ボタンを disabled にするので、再クリックはここに届かない
        busy = true;
        buttonEls.forEach((el) => {
          el.disabled = true;
        });
        // disabled になった要素はフォーカスを失うので、トラップの内側に留める
        dialog.focus();
        let shouldClose: boolean | undefined = false; // onClick が例外を投げたときは閉じずに戻す
        try {
          shouldClose = btn.onClick ? await btn.onClick() : true;
        } finally {
          busy = false;
          if (shouldClose === false) {
            buttonEls.forEach((el, i) => {
              el.disabled = buttons[i]?.disabled ?? false;
            });
          }
        }
        if (shouldClose !== false) {
          closeModal();
        } else {
          button.focus();
        }
      });

      buttonEls.push(button);
      footer.appendChild(button);
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const a11y = attachDialogA11y(dialog, {
      labelledBy: dialog.querySelector<HTMLElement>('.modal-header h3')!,
      initialFocus: pickInitialFocus(buttons, buttonEls),
      closeOnEscape,
      onRequestClose: () => {
        if (!busy) closeModal();
      },
    });

    // Close modal function (冪等: どの経路から何度呼ばれても片付けと resolve は 1 回)
    const closeModal = (): void => {
      if (closed) return;
      closed = true;
      a11y.close();
      overlay.classList.add('hidden');
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 200);
    };

    // Handle overlay click
    if (closeOnOverlayClick) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay && !busy) {
          closeModal();
        }
      });
    }
  });
}

// ============================================================================
// Countdown Dialog
// ============================================================================

export interface CountdownDialogOptions {
  /** Dialog title */
  title: string;
  /** Message to show (above countdown) */
  message: string;
  /** Initial countdown in seconds */
  seconds: number;
  /** Button text for continue action */
  continueButtonText: string;
  /** Optional header icon */
  icon?: string;
  /** Optional dialog ID for uniqueness */
  dialogId?: string;
  /** Optional countdown label */
  countdownLabel?: string;
  /**
   * 状態契約の `data-dialog` に出す名前 (packages/editor/AGENTS.md「状態契約」)。
   * overlay (開閉で `.hidden` が付く・DOM から外れる要素) に付ける。
   */
  dialogName?: string;
}

/**
 * Show a countdown dialog
 *
 * @returns true if continue button clicked, false if timeout
 */
export function showCountdownDialog(options: CountdownDialogOptions): Promise<boolean> {
  const {
    title,
    message,
    seconds,
    continueButtonText,
    icon = 'fa-clock',
    dialogId = 'countdown-dialog-overlay',
    countdownLabel = '',
    dialogName,
  } = options;

  return new Promise((resolve) => {
    // Remove existing dialog (前の回の timer とリスナーも解放する)
    overlayDisposers.get(dialogId)?.();
    document.getElementById(dialogId)?.remove();

    let remainingSeconds = seconds;
    let countdownInterval: ReturnType<typeof setInterval> | null = null;

    const formatTime = (secs: number): string => {
      const min = Math.floor(secs / 60);
      const sec = secs % 60;
      return `${min}:${sec.toString().padStart(2, '0')}`;
    };

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = dialogId;
    overlay.className = 'modal-overlay';
    if (dialogName) overlay.dataset.dialog = dialogName;
    overlay.innerHTML = `
      <div class="modal-dialog modal-info countdown-dialog">
        <div class="modal-header">
          <i class="fas ${icon}" aria-hidden="true"></i>
          <h3>${title}</h3>
        </div>
        <div class="modal-body">
          <p>${message}</p>
          <div class="countdown-display">
            <span class="countdown-time">${formatTime(remainingSeconds)}</span>
            ${countdownLabel ? `<span class="countdown-label">${countdownLabel}</span>` : ''}
          </div>
        </div>
        <div class="modal-footer">
          <button class="modal-btn modal-btn-primary countdown-continue-btn">
            <i class="fas fa-play"></i>
            ${continueButtonText}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const countdownTimeEl = overlay.querySelector('.countdown-time');
    const continueBtn = overlay.querySelector<HTMLElement>('.countdown-continue-btn');
    const dialog = overlay.querySelector<HTMLElement>('.countdown-dialog')!;

    // a11y (#305): 名前付きの modal dialog、続行ボタンへの初期フォーカス、Tab の閉じ込め。
    // 閉じる手段は続行ボタンと時間切れだけ (Escape では閉じない = 従来どおり)
    const a11y = attachDialogA11y(dialog, {
      labelledBy: dialog.querySelector<HTMLElement>('.modal-header h3')!,
      initialFocus: continueBtn,
      closeOnEscape: false,
      onRequestClose: () => undefined,
    });

    // 冪等: 続行・時間切れ・出し直しのどれから呼ばれても片付けは 1 回
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      if (overlayDisposers.get(dialogId) === dispose) overlayDisposers.delete(dialogId);
      a11y.close();
    };
    overlayDisposers.set(dialogId, dispose);

    const cleanup = (): void => {
      dispose();
      overlay.classList.add('hidden');
      setTimeout(() => overlay.remove(), 200);
    };

    // Start countdown
    countdownInterval = setInterval(() => {
      remainingSeconds--;
      if (countdownTimeEl) {
        countdownTimeEl.textContent = formatTime(remainingSeconds);
      }

      if (remainingSeconds <= 0) {
        cleanup();
        resolve(false); // Timeout
      }
    }, 1000);

    // Continue button click
    continueBtn?.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });
  });
}

// ============================================================================
// Lock Overlay
// ============================================================================

export interface LockOverlayOptions {
  /** Overlay ID */
  overlayId: string;
  /** Main title */
  title: string;
  /** Description message */
  description: string;
  /** Optional hint text */
  hint?: string;
  /** Button text */
  buttonText: string;
  /** Icon class (without fa- prefix) */
  icon?: string;
  /** Callback when button is clicked */
  // biome-ignore lint/suspicious/noConfusingVoidType: コールバックの戻り値として「何も返さない関数」(`() => void`) も受けるため。undefined に置き換えると、呼び出し側の `() => void` 型のハンドラを渡せなくなる
  onResume: () => void | Promise<boolean | undefined>;
  /** Custom class name */
  className?: string;
  /** Secondary button text (optional) */
  secondaryButtonText?: string;
  /** Callback when secondary button is clicked */
  // biome-ignore lint/suspicious/noConfusingVoidType: コールバックの戻り値として「何も返さない関数」(`() => void`) も受けるため。undefined に置き換えると、呼び出し側の `() => void` 型のハンドラを渡せなくなる
  onSecondaryAction?: () => void | Promise<boolean | undefined>;
  /**
   * 状態契約の `data-dialog` に出す名前 (packages/editor/AGENTS.md「状態契約」)。
   * overlay (開閉で `.hidden` が付く・DOM から外れる要素) に付ける。
   */
  dialogName?: string;
}

/**
 * Show a fullscreen lock overlay
 *
 * @returns Object with hide method to remove the overlay
 */
export function showLockOverlay(options: LockOverlayOptions): { hide: () => void } {
  const {
    overlayId,
    title,
    description,
    hint,
    buttonText,
    icon = 'pause-circle',
    onResume,
    className = 'lock-overlay',
    secondaryButtonText,
    onSecondaryAction,
    dialogName,
  } = options;

  // Remove existing overlay (前の回のリスナーも解放する)
  overlayDisposers.get(overlayId)?.();
  document.getElementById(overlayId)?.remove();

  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.className = className;
  if (dialogName) overlay.dataset.dialog = dialogName;
  // Use content class based on overlay class (e.g., screen-capture-lock-overlay -> screen-capture-lock-content)
  const contentClass = className.replace('-overlay', '-content');

  // Build buttons HTML
  let buttonsHtml = `
    <button class="btn btn-primary ${contentClass}-btn">
      <i class="fas fa-play"></i>
      ${buttonText}
    </button>
  `;

  if (secondaryButtonText && onSecondaryAction) {
    buttonsHtml += `
      <button class="btn btn-secondary ${contentClass}-btn-secondary">
        <i class="fas fa-eye-slash"></i>
        ${secondaryButtonText}
      </button>
    `;
  }

  overlay.innerHTML = `
    <div class="${contentClass}">
      <i class="fas fa-${icon} fa-4x" aria-hidden="true"></i>
      <h2>${title}</h2>
      <p>${description}</p>
      ${hint ? `<p class="${contentClass}-hint">${hint}</p>` : ''}
      <div class="${contentClass}-buttons">
        ${buttonsHtml}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const content = overlay.querySelector<HTMLElement>(`.${contentClass}`)!;
  const resumeBtn = overlay.querySelector<HTMLElement>(`.${contentClass}-btn`);

  // a11y (#305): 名前付きの modal dialog、再開ボタンへの初期フォーカス、Tab の閉じ込め。
  // 閉じる手段はボタン (と呼び出し側の hide / hideLockOverlay) だけ (Escape では閉じない = 従来どおり)
  const a11y = attachDialogA11y(content, {
    labelledBy: content.querySelector<HTMLElement>('h2')!,
    initialFocus: resumeBtn,
    closeOnEscape: false,
    onRequestClose: () => undefined,
  });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (overlayDisposers.get(overlayId) === dispose) overlayDisposers.delete(overlayId);
    a11y.close();
  };
  overlayDisposers.set(overlayId, dispose);

  // コールバックの実行中は、どちらのボタンからも新しい操作を受けない (showModal と同じ。#744)。
  // disabled にするとフォーカスが外れて Tab の閉じ込めに響くので、ハンドラ側で弾く。
  // false を返した・throw した後は再び押せるよう、finally で戻す
  let busy = false;
  // biome-ignore lint/suspicious/noConfusingVoidType: onResume / onSecondaryAction と同じ型を受けるため
  const runAction = async (action: () => void | Promise<boolean | undefined>): Promise<void> => {
    if (busy) return;
    busy = true;
    let result: unknown;
    try {
      result = await action();
    } finally {
      busy = false;
    }
    // If callback returns true or void, hide the overlay
    if (result !== false) {
      hide();
    }
  };

  resumeBtn?.addEventListener('click', () => runAction(onResume));

  // Secondary button handler
  if (secondaryButtonText && onSecondaryAction) {
    const secondaryBtn = overlay.querySelector(`.${contentClass}-btn-secondary`);
    secondaryBtn?.addEventListener('click', () => runAction(onSecondaryAction));
  }

  const hide = (): void => {
    dispose();
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 200);
  };

  return { hide };
}

/**
 * Hide a lock overlay by ID
 */
export function hideLockOverlay(overlayId: string): void {
  overlayDisposers.get(overlayId)?.();
  const overlay = document.getElementById(overlayId);
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 200);
  }
}
