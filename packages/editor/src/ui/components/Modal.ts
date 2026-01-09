/**
 * Modal Component
 *
 * Provides functionality for showing and managing modal dialogs.
 */

export interface ModalButton {
  /** Button text */
  text: string;
  /** Button type for styling */
  type: 'primary' | 'cancel' | 'danger';
  /** Click handler - if returns true, modal closes */
  onClick?: () => boolean | void | Promise<boolean | void>;
  /** Whether button is disabled */
  disabled?: boolean;
  /** Optional icon class (Font Awesome) */
  icon?: string;
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
  /** Custom CSS class for the modal dialog */
  className?: string;
}

/**
 * Show a modal dialog
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
    className,
  } = options;

  return new Promise((resolve) => {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = `modal-dialog modal-${variant}`;
    if (className) {
      dialog.classList.add(className);
    }

    // Build dialog HTML
    dialog.innerHTML = `
      <div class="modal-header">
        <i class="fas ${icon}"></i>
        <h3>${title}</h3>
      </div>
      <div class="modal-body">
        ${content}
      </div>
      <div class="modal-footer"></div>
    `;

    // Add buttons
    const footer = dialog.querySelector('.modal-footer')!;
    buttons.forEach((btn, index) => {
      const button = document.createElement('button');
      button.className = `modal-btn modal-btn-${btn.type}`;
      if (btn.disabled) {
        button.disabled = true;
      }
      button.innerHTML = btn.icon
        ? `<i class="fas ${btn.icon}"></i> ${btn.text}`
        : btn.text;

      button.addEventListener('click', async () => {
        const shouldClose = btn.onClick ? await btn.onClick() : true;
        if (shouldClose !== false) {
          closeModal();
        }
      });

      footer.appendChild(button);
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Close modal function
    const closeModal = (): void => {
      overlay.classList.add('hidden');
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 200);
    };

    // Handle overlay click
    if (closeOnOverlayClick) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          closeModal();
        }
      });
    }

    // Handle escape key
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        closeModal();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  });
}

/**
 * Show a confirmation dialog
 */
export async function showConfirmDialog(
  title: string,
  message: string,
  options: {
    confirmText?: string;
    cancelText?: string;
    variant?: 'default' | 'danger';
    icon?: string;
  } = {}
): Promise<boolean> {
  const {
    confirmText = 'OK',
    cancelText = 'Cancel',
    variant = 'default',
    icon = 'fa-question-circle',
  } = options;

  let confirmed = false;

  await showModal({
    title,
    content: `<p>${message}</p>`,
    variant,
    icon,
    closeOnOverlayClick: false,
    buttons: [
      {
        text: cancelText,
        type: 'cancel',
      },
      {
        text: confirmText,
        type: variant === 'danger' ? 'danger' : 'primary',
        onClick: () => {
          confirmed = true;
          return true;
        },
      },
    ],
  });

  return confirmed;
}

/**
 * Show an alert dialog
 */
export async function showAlertDialog(
  title: string,
  message: string,
  options: {
    buttonText?: string;
    variant?: 'default' | 'danger' | 'info';
    icon?: string;
  } = {}
): Promise<void> {
  const {
    buttonText = 'OK',
    variant = 'info',
    icon = 'fa-info-circle',
  } = options;

  await showModal({
    title,
    content: `<p>${message}</p>`,
    variant,
    icon,
    buttons: [
      {
        text: buttonText,
        type: 'primary',
      },
    ],
  });
}

/**
 * Terms Modal Manager
 *
 * Handles the terms of service modal workflow.
 */
export class TermsModalManager {
  private readonly storageKey: string;
  private readonly version: string;

  constructor(storageKey: string = 'typedcode-terms-accepted', version: string = '1.0') {
    this.storageKey = storageKey;
    this.version = version;
  }

  /**
   * Check if terms have been accepted
   */
  hasAccepted(): boolean {
    const accepted = localStorage.getItem(this.storageKey);
    if (!accepted) return false;
    try {
      const data = JSON.parse(accepted);
      return data.version === this.version;
    } catch {
      return false;
    }
  }

  /**
   * Mark terms as accepted
   */
  acceptTerms(): void {
    const timestamp = Date.now();
    localStorage.setItem(
      this.storageKey,
      JSON.stringify({
        version: this.version,
        timestamp,
        agreedAt: new Date(timestamp).toISOString(),
      })
    );
    console.log('[TypedCode] Terms accepted at', new Date(timestamp).toISOString());
  }

  /**
   * Show the terms modal and wait for acceptance
   * Uses existing DOM elements
   *
   * @param modalId - ID of the modal element
   * @param checkboxId - ID of the agreement checkbox
   * @param buttonId - ID of the agree button
   */
  async showModal(
    modalId: string = 'terms-modal',
    checkboxId: string = 'terms-agree-checkbox',
    buttonId: string = 'terms-agree-btn'
  ): Promise<void> {
    const modal = document.getElementById(modalId);
    const checkbox = document.getElementById(checkboxId) as HTMLInputElement | null;
    const button = document.getElementById(buttonId) as HTMLButtonElement | null;

    if (!modal || !checkbox || !button) {
      console.error('[TermsModalManager] Modal elements not found');
      return;
    }

    return new Promise((resolve) => {
      modal.classList.remove('hidden');

      const handleCheckboxChange = (): void => {
        button.disabled = !checkbox.checked;
      };

      const handleAgree = (): void => {
        this.acceptTerms();
        checkbox.removeEventListener('change', handleCheckboxChange);
        button.removeEventListener('click', handleAgree);
        modal.classList.add('hidden');
        resolve();
      };

      checkbox.addEventListener('change', handleCheckboxChange);
      button.addEventListener('click', handleAgree);
    });
  }

  /**
   * Ensure terms are accepted before proceeding
   */
  async ensureAccepted(
    modalId?: string,
    checkboxId?: string,
    buttonId?: string
  ): Promise<void> {
    if (!this.hasAccepted()) {
      console.log('[TypedCode] Showing terms modal...');
      await this.showModal(modalId, checkboxId, buttonId);
    }
  }
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
  } = options;

  return new Promise((resolve) => {
    // Remove existing dialog
    const existing = document.getElementById(dialogId);
    existing?.remove();

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
    overlay.innerHTML = `
      <div class="modal-dialog modal-info countdown-dialog">
        <div class="modal-header">
          <i class="fas ${icon}"></i>
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
    const continueBtn = overlay.querySelector('.countdown-continue-btn');

    const cleanup = (): void => {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
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
  onResume: () => void | Promise<boolean | void>;
  /** Custom class name */
  className?: string;
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
  } = options;

  // Remove existing overlay
  const existing = document.getElementById(overlayId);
  existing?.remove();

  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.className = className;
  overlay.innerHTML = `
    <div class="lock-overlay-content">
      <i class="fas fa-${icon} fa-4x"></i>
      <h2>${title}</h2>
      <p>${description}</p>
      ${hint ? `<p class="lock-overlay-hint">${hint}</p>` : ''}
      <button class="btn btn-primary lock-overlay-btn">
        <i class="fas fa-play"></i>
        ${buttonText}
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  const resumeBtn = overlay.querySelector('.lock-overlay-btn');
  resumeBtn?.addEventListener('click', async () => {
    const result = await onResume();
    // If callback returns true or void, hide the overlay
    if (result !== false) {
      hide();
    }
  });

  const hide = (): void => {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 200);
  };

  return { hide };
}

/**
 * Hide a lock overlay by ID
 */
export function hideLockOverlay(overlayId: string): void {
  const overlay = document.getElementById(overlayId);
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 200);
  }
}

// ============================================================================
// Terms Modal Manager
// ============================================================================

// Singleton instance
let termsModalManager: TermsModalManager | null = null;

/**
 * Get the singleton TermsModalManager instance
 */
export function getTermsModalManager(): TermsModalManager {
  if (!termsModalManager) {
    termsModalManager = new TermsModalManager();
  }
  return termsModalManager;
}
