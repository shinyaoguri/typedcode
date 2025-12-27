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
